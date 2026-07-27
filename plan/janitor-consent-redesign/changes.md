# S02 changes — markIdle propagation at finalize chokepoint

## Root cause / objective
`SessionRegistryService.markIdle` had zero callers, so `helm_sessions` never became `idle` when worker/planning seats finished. S01 consolidated orchestrator terminal writes onto `finalizeWorkerRuntimeRow`, but boundary-sweep `reapLiveRunWorkers` and `WorkerService` launch-error still wrote terminal state inline — S02 markIdle-only-inside-finalizer would have missed those paths.

## Mechanism
1. After a **first successful** `worker_runtimes` terminal transition (`changes===1`), call injected `markIdle(session, reason)` reusing `SessionRegistryService.markIdle` (no status SQL duplication).
2. `configureWorkerRuntimeFinalize({ markIdle })` wired in `src/index.ts` beside existing registry hooks.
3. Preserve markIdle no-ops: absent row, already-`reaped`, null/empty session (no throw).
4. Prefer same-connection `db.transaction` when available (SD1); markIdle errors are swallowed so they never block the runtime write.

## Code changes
- `src/services/worker-runtime-finalize.ts`
  - Added `configureWorkerRuntimeFinalize` / markIdle hook.
  - On successful first transition: `SELECT session` → `markIdle(session, reason)`.
- `src/index.ts`
  - Wire production markIdle: `sessionRegistry.markIdle`.
- `src/services/orchestrator-loop.ts`
  - **MANDATORY residual:** `reapLiveRunWorkers` inline `UPDATE … reaped` → `finalizeWorkerRuntimeRow` (transport.reap still first).
- `src/services/worker-service.ts`
  - Launch-error catch (~247) inline `failed` write → `finalizeWorkerRuntimeRow` (session already terminated → markReaped; markIdle correctly no-ops).
- `src/a15-worker-finalize.test.ts`
  - S02 cases (1)–(4): idle+reason, reaped stays reaped, no-op no registry change, null/empty/absent safe.
- `src/services/orchestrator-loop.test.ts`
  - S02 case (5)/(5b): `reapLiveRunWorkers` uses chokepoint + registry idle/reaped-aligned.

## Guardrails maintained
- `HELM_SESSION_JANITOR` untouched (stays `0`).
- Synthetic temp DB only; FakeTransport only; no live tmux reaping.
- Deferral OFF.

## Domain notes
- `worker-service.ts` launch-error: folded for chokepoint hygiene (worker_runtimes terminal writer). Registry already `reaped` via terminate→onTerminate before finalize.
- Planning-phase seats already call `finalizeWorkerRuntimeRow` → get markIdle for free once hook is configured.

## Test status
Ran: `npx vitest run src/a15-worker-finalize.test.ts src/services/orchestrator-loop.test.ts --poolOptions.forks.maxForks=2`

**Result: 77 passed | 2 skipped (79)** — exit 0. Pre-existing 2 skips (C2/C3/C4 wiring). New S02 cases green: markIdle (1)–(4) in a15 + reapLiveRunWorkers (5)/(5b) in orchestrator-loop. Live `data/helm.db` mtime untouched (predates this work). `HELM_SESSION_JANITOR=0` in `.env` and `ecosystem.config.cjs`.
