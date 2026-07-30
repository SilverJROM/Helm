# A1 test-report.md

**Batch:** A1
**File under test:** `src/services/run-orchestrator-planning-terminal-a1.test.ts`
**Date:** 2026-07-30
**Environment:** `USE_FAKE_TMUX=1` + `NODE_ENV=test` (set in file), isolated temp SQLite DB per
test file run, no model tokens.

## Command

```bash
HELM_DB_PATH=/tmp/helm-a1-$$.db npx vitest run src/services/run-orchestrator-planning-terminal-a1.test.ts
```

## Result

```
 ✓ src/services/run-orchestrator-planning-terminal-a1.test.ts (4 tests) 604ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
 Duration  1.30s
```

| # | Case | Expected | Observed |
|---|------|----------|----------|
| 1 | `transitionRunToBlocked`, run still `planning` phase, 0 `run_tasks` | terminal UPDATE still lands (`phase='blocked'`, `status='failed'`); `assertImplementationBrainComplete` NOT called; 0 `worker_runtimes` rows with `role='ibrain'` for the run | PASS |
| 2 | `transitionRunToBlocked`, run `executing` phase + 1 `run_tasks` row (regression) | terminal UPDATE lands; `assertImplementationBrainComplete` called exactly once; a genuine `ibrain` `worker_runtimes` row is finalized | PASS |
| 3 | `startRunDetached` background `.catch`, run left at `starting` (mocked `startRun` never advances phase), 0 `run_tasks` | CAS UPDATE lands (`phase='failed'`, `status='failed'`); `assertImplementationBrainComplete` NOT called; 0 `ibrain` rows | PASS |
| 4 | `startRunDetached` background `.catch`, run manually advanced to `executing` + 1 `run_tasks` row (regression) | CAS UPDATE lands; `assertImplementationBrainComplete` called exactly once; a genuine `ibrain` row is finalized | PASS |

Cases 1 and 3 are the direct AC1 proof (does not call the assertion, does not synthesize
completion). Cases 2 and 4 prove the brief's "do not weaken genuine execution failure cleanup"
clause — the gate is phase/task-aware, not a blanket skip.

## Regression check (sibling suite, not required by the brief's gate but run for confidence)

```bash
HELM_DB_PATH=/tmp/helm-a1-verify2-$$.db npx vitest run src/services/run-orchestrator-service.test.ts -t "B04"
```

```
 ✓ src/services/run-orchestrator-service.test.ts (59 tests | 50 skipped) 1019ms
 Test Files  1 passed (1)
      Tests  9 passed | 50 skipped (59)
```

All 9 `B04` CAS-generation tests (which drive `transitionRunToBlocked` and
`startRunDetached`'s catch directly, including two that assert `assertImplementationBrainComplete`
DOES fire on a live-generation run) remain green — the gate does not break the pre-existing
generation-CAS behavior.

One unrelated pre-existing flake was observed and independently reproduced on the unmodified
branch tip via `git stash`: `startRun with real escalationService: validator incapability flag
triggers brain judgment + rung-bump` times out waiting for a fake implementer spawn. Same failure,
same timeout, with or without this batch's diff — not caused by this change, not in AC1/AC23
scope.

## Token burn

**None.** In-memory/temp-file SQLite DB, `FakeTransport`, no seat spawn, no model API.

## Acceptance map

| Criterion | Status |
|-----------|--------|
| Capture pre-terminal execution state before the blocked UPDATE | PASS (`hasExecutionStarted` read before both terminal UPDATEs) |
| `assertImplementationBrainComplete` does not run when execution never started | PASS (cases 1, 3) |
| Genuine execution failure cleanup not weakened | PASS (cases 2, 4; B04 suite green) |
| One new dedicated A1 unit-test file | PASS |
| Stay within `run-orchestrator-service.ts` + new test/artifacts only | PASS |
| Targeted vitest green | PASS |
