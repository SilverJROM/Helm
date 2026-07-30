# A1 changes.md — skip implementation-brain assertion when execution never started

**Batch:** A1
**Branch:** `fix/planning-agreement-restructure`
**Requirements:** AC1, AC23
**Scope:** `src/services/run-orchestrator-service.ts` + one new dedicated test file only

## Summary

Two production call sites unconditionally called `assertImplementationBrainComplete` after
stamping a run terminal, with no check for whether execution had actually begun:

- `transitionRunToBlocked` (blocked/failed UPDATE, then the `kind === 'failure'` finalize block)
- `startRunDetached`'s background `.catch` (CAS UPDATE, then the finalize IIFE)

`assertImplementationBrainComplete` → `finalizeBrainSessionRow`
(`src/services/worker-runtime-finalize.ts:168-260`) is register-if-needed: when no
`worker_runtimes` row exists yet for `(run_id, session)` it INSERTs one and immediately finalizes
it done/failed. On a run that failed during planning — before any implementation brain ever
spawned — this synthesized a phantom `worker_runtimes` `ibrain` row that never existed, marking it
complete.

## Mechanism

Added `private hasExecutionStarted(runId): boolean`, read **before** either terminal UPDATE
(since both overwrite `runs.phase`):

- "started" if `runs.phase` is not one of `starting` / `interview` / `planning` (mirrors
  `stopRun`'s own `priorPhase` gate at `:2380-2405`, which already draws this exact line for its
  own ibrain-vs-reap branch), **or** if `run_tasks` for the run is non-empty (belt-and-suspenders
  per the brief — a crash could in principle land the phase write and the run_tasks ingest on
  either side of the failure boundary).
- Defaults to `true` (assume started) on any read error — the predicate must never suppress
  genuine execution-failure cleanup, only skip the assert when planning-only failure is certain.

Both call sites now capture `executionStarted` immediately before their terminal UPDATE, and gate
only the `assertImplementationBrainComplete` call on it. `finalizeRunWorkerRuntimes` is
**unconditional** at both sites — untouched — so genuine worker-runtime reaping is unaffected
either way.

No other call site (`:2082` completion tail, `:2399` `stopRun`'s own executing-phase branch) was
touched — those are genuine execution-terminal paths, out of AC1's scope.

## Files changed

| Path | Action |
|------|--------|
| `src/services/run-orchestrator-service.ts` | **EDIT** — add `hasExecutionStarted`; gate 2 call sites |
| `src/services/run-orchestrator-planning-terminal-a1.test.ts` | **ADD** — 4 dedicated tests |

## Commands run

```bash
HELM_DB_PATH=/tmp/helm-a1-$$.db npx vitest run src/services/run-orchestrator-planning-terminal-a1.test.ts
HELM_DB_PATH=/tmp/helm-a1-verify2-$$.db npx vitest run src/services/run-orchestrator-service.test.ts -t "B04"
```

## Out of scope (intentionally)

- `worker-runtime-finalize.ts` / `finalizeBrainSessionRow` becoming update-only — that is A2's
  structural fix (`finalizeBrainSessionRow` register-if-needed insert removal), not this slice.
- `real-transport.ts` — owned by the concurrently-running C1 slice; not touched.
- `src/index.ts`, schema, any other stream's files — not touched.
