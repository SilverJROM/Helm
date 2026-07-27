# S01 changes

## Root cause / objective
Consolidate the orchestrator-loop terminal worker-runtime finalizer to the shared `finalizeWorkerRuntimeRow` chokepoint and ensure all terminal pathways in `finalizeWorkerRuntime()` use that path.

## Code changes
- `src/services/orchestrator-loop.ts`: replaced inline `UPDATE worker_runtimes ...` in `OrchestratorLoop.finalizeWorkerRuntime()` with `finalizeWorkerRuntimeRow(db, id, state, reason)` import.
- `src/services/orchestrator-loop.test.ts`: added S01-focused synthetic DB tests asserting every terminal outcome invokes `finalizeWorkerRuntimeRow` for path coverage.
  - DONE callback path
  - seat-auth terminal path
  - callback timeout failure path
  - run-abort path
- `src/a15-worker-finalize.test.ts`: added regression asserting `finalizeWorkerRuntimeRow` is idempotent and does not overwrite an already terminal row.

## Guardrails maintained
- No `tmux`/live session interaction in tests.
- No access to `data/helm.db`.
- Did not modify `HELM_SESSION_JANITOR` or markIdle-related paths.

## Test status
Not executed by request. Changes are test-only for new assertions in synthetic/in-memory DB setups.
