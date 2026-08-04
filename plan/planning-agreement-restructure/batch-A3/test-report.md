# A3 test-report.md

**Batch:** A3
**File under test:** `src/services/worker-runtime-finalize-a3.test.ts`
**Date:** 2026-07-30
**Environment:** isolated temp SQLite DB per test file run, real `SessionRegistryService` CAS
path (not mocked), no model tokens, no tmux.

## Command

```bash
HELM_DB_PATH=/tmp/helm-a3-$$.db npx vitest run src/services/worker-runtime-finalize-a3.test.ts
```

## Result

```
 ✓ src/services/worker-runtime-finalize-a3.test.ts (3 tests) 180ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
 Duration  526ms
```

| # | Case | Expected | Observed |
|---|------|----------|----------|
| 1 | Session `helm-ibrain-a3_brain` currently registered to `runB` (live, `active`); a stale `worker_runtimes` row from `runA`, same session name, finalized | Runtime row still transitions to terminal (`reaped`) — only `markIdle` propagation is guarded; `runB`'s registry row stays `active`, `run_id` still `runB` | PASS |
| 2 | Session registered to `runA`; `worker_runtimes` row also `run_id=runA`, finalized | Registry row marked `idle` with the finalize reason (regression guard — proves the fix isn't over-tightened) | PASS |
| 3 | Session registered with `runId: null`; `worker_runtimes` row also `run_id: null` (ad-hoc no-run-context worker), finalized | Registry row still marked `idle` — proves the null-safe `IS` predicate preserves the existing no-run-context behavior instead of turning it into a silent no-op | PASS |

Case 1 is the direct AC3 proof (unrelated live session never marked idle by a stale run's
finalize). Case 2 proves the tightened join still asserts idle for the legitimate matching case.
Case 3 proves the specific null-safety design choice (`IS` vs `=`) documented in `changes.md`
doesn't regress the pre-existing ad-hoc-worker path.

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

No errors in `worker-runtime-finalize.ts` or `worker-runtime-finalize-a3.test.ts`.

## Regression checks (not required by the brief's gate, run for confidence)

```bash
HELM_DB_PATH=/tmp/helm-a3-regress-$$.db npx vitest run src/services/worker-runtime-finalize-a2.test.ts src/services/worker-runtime-finalize-a3.test.ts
```

```
 ✓ src/services/worker-runtime-finalize-a2.test.ts (4 tests) 180ms
 ✓ src/services/worker-runtime-finalize-a3.test.ts (3 tests) 137ms
 Test Files  2 passed (2)
      Tests  7 passed (7)
```

A2's gate stays green alongside A3's — the run-identity JOIN predicate does not disturb A2's
update-only `finalizeBrainSessionRow` cases (none of which configure `markIdleHook`).

```bash
HELM_DB_PATH=/tmp/helm-a3-check-$$.db npx vitest run src/a15-worker-finalize.test.ts
```

```
 Test Files  1 failed (1)
      Tests  4 failed | 16 passed (20)
```

Identical failure count and identical 4 failing cases to A2's already-documented collateral
(register-if-needed assumption, `a15-worker-finalize.test.ts` lines 397/464/484/537) — A3
introduces **zero additional** failures in that integration-owned capstone file. Not edited here
per standing rule 4/5.

## Token burn

**None.** In-memory/temp-file SQLite DB only, no seat spawn, no model API.

## Acceptance map

| Criterion | Status |
|-----------|--------|
| `assertRegistryIdle` asserts idle only for the helm session row owned by the same run/runtime identity, not name alone | PASS (case 1) |
| Existing CAS token flow (`sessionStatusTokenFromRow`) and best-effort behavior preserved | PASS (unchanged code path; case 2's token/CAS write succeeds normally) |
| Missing/non-matching run-owned helm session → no-op, no throw, no unrelated session marked idle | PASS (case 1; existing `if (!row?.name) return;` guard, unchanged) |
| `HELM_SESSION_JANITOR` not enabled or modified | PASS (not referenced anywhere in the diff) |
| One new dedicated A3 unit-test file, same-name-unrelated-live-session + matching-run-owned-session cases | PASS |
| Stay within `worker-runtime-finalize.ts` + new test/artifacts only | PASS |
| Targeted vitest green | PASS |
| Raceguard count stays 3 | PASS |
