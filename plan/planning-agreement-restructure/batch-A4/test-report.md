# A4 test-report.md

**Batch:** A4
**File under test:** `src/services/run-orchestrator-planning-cycle-a4.test.ts`
**Date:** 2026-07-30
**Environment:** `USE_FAKE_TMUX=1` + `NODE_ENV=test`, isolated temp SQLite DB per test file run,
real `CycleService`/`TopologyFreezeService` (not mocked), no model tokens.

## Command

```bash
HELM_DB_PATH=/tmp/helm-a4-$$.db npx vitest run src/services/run-orchestrator-planning-cycle-a4.test.ts
```

## Result

```
 ✓ src/services/run-orchestrator-planning-cycle-a4.test.ts (5 tests) 744ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
 Duration  1.41s
```

| # | Case | Expected | Observed |
|---|------|----------|----------|
| 1 | `transitionRunToBlocked`, cycle in `planning`, run still `planning`, 0 `run_tasks` | Run terminal UPDATE still lands (`phase='blocked'`, `status='failed'`); cycle stays `'planning'`; zero `cycle_topology_freezes` rows | PASS |
| 2 | `transitionRunToBlocked`, cycle already in `implementation` (frozen once), run `executing` + 1 `run_tasks` (regression) | Run terminal lands; cycle flips to `'complete'`; freeze count stays exactly `1` (idempotent — genuinely re-terminalized, not double-frozen) | PASS |
| 3 | `transitionRunToBlocked`, `kind='operator-pause'`, run `executing` + 1 `run_tasks` | Run lands `phase='blocked'`, `status='paused'`; cycle untouched at `'planning'`; zero freeze rows (A6 park stays non-terminal, unweakened) | PASS |
| 4 | `startRunDetached` background `.catch`, run left at `starting` (mocked `startRun` never advances phase), 0 `run_tasks` | CAS UPDATE lands (`phase='failed'`); cycle stays `'planning'`; zero freeze rows | PASS |
| 5 | `startRunDetached` background `.catch`, run manually advanced to `executing` + 1 `run_tasks` (regression) | CAS UPDATE lands; cycle flips to `'complete'` | PASS |

Cases 1 and 4 are the direct AC4 proof (planning-only failure leaves the cycle non-complete,
no topology freeze, at both call sites). Cases 2 and 5 prove the gate does not weaken genuine
execution-failure cycle terminalization. Case 3 proves operator-pause behavior is unweakened —
it was already unaffected by `kind === 'failure'` gating and stays that way.

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

No errors in `run-orchestrator-service.ts` or `run-orchestrator-planning-cycle-a4.test.ts`.

## Regression check (sibling suite — surfaced newly-discovered A2 collateral, not an A4 regression)

```bash
HELM_DB_PATH=/tmp/helm-a4-regress-$$.db npx vitest run src/services/run-orchestrator-planning-terminal-a1.test.ts src/services/run-orchestrator-planning-cycle-a4.test.ts
```

```
 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 7 passed (9)
```

The 2 failures are both in A1's own file (`run-orchestrator-planning-terminal-a1.test.ts`), not
A4's. **Isolated the cause:** re-ran A1's file alone against the current tree —

```bash
HELM_DB_PATH=/tmp/helm-a4-a1check-$$.db npx vitest run src/services/run-orchestrator-planning-terminal-a1.test.ts
```
```
 Tests  2 failed | 2 passed (4)
```

Both failures are the "regression: an executing-phase failure still calls
assertImplementationBrainComplete and finalizes a genuine ibrain row" cases (:114
`transitionRunToBlocked`, :174 `startRunDetached`) — `assertSpy` **is** still called exactly once
(that assertion passes); only `ibrainWorkerRows(runId)).toHaveLength(1)` now fails
(`expected [] to have length 1 but got +0`), because neither test pre-inserts a `worker_runtimes`
row and both depend on A2's now-removed register-if-needed path to synthesize one. This is the
identical root cause A2 already documented for `src/a15-worker-finalize.test.ts`, just present in
a second file. Confirmed this predates A4's diff and is not something this batch introduced —
flagged in `changes.md`, not fixed here (out of scope: another batch's already-closed test file).

## Token burn

**None.** In-memory/temp-file SQLite DB, `FakeTransport`, no seat spawn, no model API.

## Acceptance map

| Criterion | Status |
|-----------|--------|
| Gate cycle terminalization so planning-only failure paths do not call `terminalizeCycleAtRunEnd` | PASS (cases 1, 4) |
| Preserve terminalization for genuine execution failures and true success terminals | PASS (cases 2, 5; true-success tail untouched) |
| Operator-pause behavior not weakened, remains non-terminal for cycles | PASS (case 3) |
| No edits to cycle schema, topology freeze schema, `src/index.ts`, or `worker-runtime-finalize.ts` | PASS |
| One new dedicated A4 unit-test file, planning-only-retryable + executing-still-terminalizes | PASS |
| Stay within `run-orchestrator-service.ts` + new test/artifacts only | PASS |
| Targeted vitest green | PASS |
| Raceguard count stays 3 | PASS |
