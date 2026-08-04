# A2 test-report.md

**Batch:** A2
**File under test:** `src/services/worker-runtime-finalize-a2.test.ts`
**Date:** 2026-07-30
**Environment:** isolated temp SQLite DB per test file run, no model tokens, no tmux.

## Command

```bash
HELM_DB_PATH=/tmp/helm-a2-$$.db npx vitest run src/services/worker-runtime-finalize-a2.test.ts
```

## Result

```
 ✓ src/services/worker-runtime-finalize-a2.test.ts (4 tests) 182ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
 Duration  507ms
```

| # | Case | Expected | Observed |
|---|------|----------|----------|
| 1 | No `worker_runtimes` row exists for `(run_id, session)` | `false`; row count for the run stays `0`; no row anywhere with `provider='unknown' AND model='unknown'` | PASS |
| 2 | An existing row for `(run_id, session)` is already `'done'` | `false`; row count for the run stays `1` (no resurrection, no second row) | PASS |
| 3 | An existing `'running'` row for `(run_id, session)` (real provider/model) | `true`; row transitions to requested terminal state with `exit_reason` set; second call on the same row → `false` (idempotent) | PASS |
| 4 | Existing non-terminal row present, but `expectedGeneration` mismatched | `false`; row left unchanged (`state` still `'running'`) — fail-closed preserved even though a row now exists to update | PASS |

Cases 1 and 2 are the direct AC2 proof (no synthesis, no resurrection, row count strictly
unchanged, no `unknown/unknown` row created). Case 3 proves the update-only path still finalizes
a genuine runtime normally and stays idempotent. Case 4 proves A2 does not regress the
`expectedGeneration` fail-closed guard now that a matching row can legitimately exist.

## Raceguard check (standing rule)

```bash
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts
```

```
3
```

Unchanged — `8024452` survives.

## Typecheck

```bash
npx tsc --noEmit -p tsconfig.json
```

No errors in `worker-runtime-finalize.ts`, `worker-runtime-finalize-a2.test.ts`, or the caller
`run-orchestrator-service.ts`.

## Known collateral (expected, not a regression I own)

```bash
HELM_DB_PATH=/tmp/helm-a2-check-$$.db npx vitest run src/a15-worker-finalize.test.ts
```

```
 Test Files  1 failed (1)
      Tests  4 failed | 16 passed (20)
```

The 4 failures are exactly the S03 describe-block assertions that exercised the now-deleted
register-if-needed path with zero pre-existing rows:

- `(1) ibrain becomes idle only at true terminal finalizeBrainSessionRow...` — `expect(changed).toBe(true)` now `false` (:397)
- `(2) plancore planning-phase finalize path...` — the trailing `finalizeBrainSessionRow` sub-case at :453-466 now leaves the registry `'active'` instead of `'idle'` (:464)
- `(3) detached-start-failed terminal uses same finalizeBrainSessionRow path (register-if-needed → idle)` — `expect(changed).toBe(true)` now `false` (:484)
- `(5) B04/AC8: matching expectedGeneration still finalizes normally` — same register-if-needed dependency, `expect(changed).toBe(true)` now `false` (:537)

All 16 other tests in that file (A15 session-gone/reap suite, B04 cases 4's mismatch assertion,
etc.) remain green — the failures are isolated to the register-if-needed assumption, not a
broader regression. `src/a15-worker-finalize.test.ts` is integration-owned per WAVE-PLAN.md
(reconciled at `I-P2`); not edited here per standing rule 4/5.

## Token burn

**None.** In-memory/temp-file SQLite DB only, no seat spawn, no model API.

## Acceptance map

| Criterion | Status |
|-----------|--------|
| Only finalizes an existing non-terminal runtime row for the given `runId`/`session` | PASS |
| No matching row → `false`, no INSERT | PASS (case 1) |
| Register-if-needed insert path deleted | PASS (code diff; case 1/2 prove no row is ever created) |
| `unknown`/`unknown` provider/model fallback defaults deleted | PASS (case 1 asserts zero such rows) |
| `expectedGeneration` fail-closed behavior preserved | PASS (case 4) |
| Idempotent `false` for already-terminal rows | PASS (case 2, case 3's second call) |
| One new dedicated A2 unit-test file | PASS |
| Stay within `worker-runtime-finalize.ts` + new test/artifacts only | PASS |
| Targeted vitest green | PASS |
| Raceguard count stays 3 | PASS |
