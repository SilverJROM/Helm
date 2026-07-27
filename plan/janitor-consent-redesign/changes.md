# S03 changes — brain seats assert completion (AC24 brains)

## Root cause / objective
S02 propagates `markIdle` only when a seat finalizes through `finalizeWorkerRuntimeRow`. Planning seats (plancore/planner partners) already do that at `planning-phase-complete`. Named `helm-ibrain-*` had **no** worker_runtimes ledger and never called markIdle at run end — D-a3 keeps the session alive for close-confirm while registry stayed `active`.

## Mechanism
1. **RETAIN** plancore/planner path: `planning-phase-service.ts` still finalizes via `finalizeWorkerRuntimeRow` at true planning-phase exit (S02 markIdle free).
2. **S03 helper** `finalizeBrainSessionRow` in `worker-runtime-finalize.ts`: register-if-needed a `worker_runtimes` row for the named brain session, then finalize through the shared chokepoint. **Does not reap/terminate** (preserves D-a3 keep-alive). Idempotent when a terminal ledger row already exists for run+session.
3. **Call sites** (true run terminals only — never intermediate yield / replan wait):
   - `runEngineTail` complete/failed — after `finalizeRunWorkerRuntimes`, before D-a3 close-confirm write
   - `transitionRunToBlocked(failure)` — after workers finalize (async ordered)
   - `stopRun` when prior phase was **not** starting/interview/planning (executing+)
   - `startRunDetached` `.catch` — after workers finalize, reason `detached-start-failed` (send-back AC1)
4. Kind map documented in S03 tests (ibrain/plancore assert; discovery human-owned; workers S02; other residual).

## Code changes
- `src/services/worker-runtime-finalize.ts` — `finalizeBrainSessionRow`
- `src/services/run-orchestrator-service.ts` — `assertImplementationBrainComplete` + 3 true-terminal call sites
- `src/a15-worker-finalize.test.ts` — S03 cases (1)(2)

## Guardrails
- `HELM_SESSION_JANITOR=0` unchanged (`.env` + `ecosystem.config.cjs`)
- Synthetic DB only; no live tmux reaping invented on ibrain assert path
- Deferral OFF

## Test status
`npx vitest run src/a15-worker-finalize.test.ts --poolOptions.forks.maxForks=2` → **11 passed**  
`npx tsc --noEmit -p .` → **exit 0**
