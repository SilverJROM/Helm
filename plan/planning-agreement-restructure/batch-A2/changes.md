# A2 changes.md — finalizeBrainSessionRow becomes update-only

**Batch:** A2
**Branch:** `fix/planning-agreement-restructure`
**Requirements:** AC2, AC23
**Scope:** `src/services/worker-runtime-finalize.ts` + one new dedicated test file only

## Summary

`finalizeBrainSessionRow` (`worker-runtime-finalize.ts:168-260`) had a register-if-needed path: if
no non-terminal `worker_runtimes` row existed for `(run_id, session)`, it INSERTed a new one
(`provider`/`model` defaulting to `'unknown'` when not supplied) and immediately finalized it. That
is the mechanism that can synthesize a phantom `ibrain` ledger row during teardown when no runtime
was ever really registered. A1 already stops the one known bad caller path (skips
`assertImplementationBrainComplete` on planning-only failure); A2 removes the synthesis capability
at the finalizer chokepoint itself, so no future caller can reintroduce the bug.

## Mechanism

Collapsed the three-query dance (existing-non-terminal → terminal-check → INSERT) into a single
SELECT for an existing non-terminal `run_id`+`session` row:

- Row found → unchanged tail: `finalizeWorkerRuntimeRow(db, id, state, reason)`.
- No row found → `return false` immediately. This one branch now correctly covers both cases the
  old code split into two queries ("never registered" and "already terminal") — neither should
  write, and update-only means there is no third case ("insert a fresh one").

Deleted the `role` / `provider` / `model` local consts (they existed only to feed the INSERT) and
the `'unknown'` fallback defaults along with them. The `opts` type keeps `role`/`provider`/`model`
as accepted-but-now-inert fields — the only caller, `assertImplementationBrainComplete`
(`run-orchestrator-service.ts:609`, untouched), still passes them as an object literal, and
removing the fields would trip a TypeScript excess-property error there. `expectedGeneration`
fail-closed check and the `session`/`projectId`/`runId` guards are unchanged.

Updated the function's JSDoc (previously "Register-if-needed") to state the update-only contract.

## Files changed

| Path | Action |
|------|--------|
| `src/services/worker-runtime-finalize.ts` | **EDIT** — `finalizeBrainSessionRow` update-only, deleted INSERT + `unknown` defaults, doc updated |
| `src/services/worker-runtime-finalize-a2.test.ts` | **ADD** — 4 dedicated tests |

## Commands run

```bash
HELM_DB_PATH=/tmp/helm-a2-$$.db npx vitest run src/services/worker-runtime-finalize-a2.test.ts
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts   # must stay 3
npx tsc --noEmit -p tsconfig.json
```

## Known collateral (flagged, not fixed — out of scope)

`src/a15-worker-finalize.test.ts` (S03 describe block) has 4 assertions that exercise the deleted
register-if-needed path with zero pre-existing rows (tests 1, 2, 3, 5 in that file) and expect
`changed === true` / registry `idle`. Those now fail, expectedly — see `test-report.md`. That file
is one of the three cross-cutting capstone tests WAVE-PLAN.md marks integration-owned
(`I-P0`/`I-P2`), not per-slice, and standing rule 4/5 forbid editing another stream's file, so it
was left untouched.

## Out of scope (intentionally)

- `src/a15-worker-finalize.test.ts` — integration-owned, reconciled at `I-P2` (see above).
- `run-orchestrator-service.ts` (A1's/A3's file) — not touched; only caller, unchanged signature.
- A3 (`assertRegistryIdle` name-only join fix) — next in the E5 chain, not this slice.
- `src/index.ts`, schema, any other stream's files — not touched.
