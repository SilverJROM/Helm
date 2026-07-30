# A0 test-report.md

**Batch:** A0  
**File under test:** `src/a0-convene-race-regression.test.ts`  
**Date:** 2026-07-30  
**Environment:** `USE_FAKE_TMUX=1` (via test file), temp `HELM_DB_PATH`, no model tokens  

## Command

```bash
HELM_DB_PATH=/tmp/helm-a0-$$.db npx vitest run src/a0-convene-race-regression.test.ts
```

## Result

```
 ✓ src/a0-convene-race-regression.test.ts (5 tests) 827ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
 Duration  1.28s
```

| # | Case | Expected | Observed |
|---|------|----------|----------|
| 1 | BROKEN + plan.md **absent** | non-dispositive; elapsed ≳ timeout − 40ms; `agreed=false` | PASS (~341ms for 280ms timeout) |
| 2 | BROKEN + plan.md **present non-empty** | dispositive fail-fast; elapsed < 400ms; `agreed=false` | PASS |
| 3 | BROKEN + plan.md **empty** | non-dispositive (size > 0 required) | PASS |
| 4 | BROKEN while absent, then plan.md appears mid-wait | becomes dispositive without new verdict | PASS |
| 5 | Source `planMdPathForRaceGuard` count | exactly **3** | PASS |

## Survival grep (required proof)

```bash
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts
# → 3
```

## Token burn

**None.** Fixture callbacks + temp filesystem only. No seat spawn, no model API.

## Acceptance map

| Criterion | Status |
|-----------|--------|
| One new dedicated unit-test file for A0 only | PASS |
| BROKEN non-dispositive while canonical plan.md absent | PASS |
| BROKEN dispositive once plan.md exists | PASS |
| No edit to `planning-phase-service.ts` or shared source | PASS |
| Targeted vitest green | PASS |
| `grep -c planMdPathForRaceGuard …` == 3 | PASS |
