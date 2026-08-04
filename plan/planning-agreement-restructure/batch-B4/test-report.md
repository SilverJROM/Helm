# test-report.md — B4

## Dedicated B4 gate

```
HELM_DB_PATH=/tmp/helm-b4-$$.db npx vitest run src/services/planning-phase-newest-verdict-b4.test.ts
```

**Result:** 4/4 passed.

Coverage:
- older `CLEAN` then a newer malformed `VERDICT-READY` for the same seat does **not** pass
  (proves the fix — previously this stale-fell-through case returned `true`).
- older `BROKEN` then a newer `CLEAN` for the same seat **can** pass once `PLAN-READY` is
  present (proves newest-wins is preserved in the legitimate direction, not just the
  fail-closed direction).
- a malformed newest line with no older verdict at all for that seat stays non-agreement,
  observed on a bounded short timeout (120ms) — proves the false return is deterministic and
  bounded, not a hang.
- regression: unanimous newest `CLEAN` across two partner seats still passes — directly
  exercises the changed early-break condition (`seenNewestVerdict.size ===
  partnerBatchIds.length`) to confirm it did not regress the multi-seat unanimous case.

## Regression sweep

```
HELM_DB_PATH=/tmp/helm-b4-regress-$$.db npx vitest run \
  src/a0-convene-race-regression.test.ts \
  src/services/planning-phase-reap-before-finalize-a5.test.ts \
  src/services/planning-phase-one-terminal-owner-a6.test.ts \
  src/services/plan-revision-b1.test.ts \
  src/services/brief-writer-panel-plan-contract-b2.test.ts \
  src/services/planning-phase-verdict-parser-b3.test.ts \
  src/services/planning-phase-newest-verdict-b4.test.ts \
  src/services/planning-phase-service.test.ts
```

**Result:** 8 files, 68/68 tests passed.

## Typecheck

```
npx tsc --noEmit
```

**Result:** clean, no errors.

## Race-guard pin

```
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts
```

**Result:** `3` (unchanged, before and after edit).
