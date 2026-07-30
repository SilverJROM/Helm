# A4 changes.md — a failed planning cycle must not terminalize

**Batch:** A4
**Branch:** `fix/planning-agreement-restructure`
**Requirements:** AC4, AC23
**Scope:** `src/services/run-orchestrator-service.ts` + one new dedicated test file only

## Summary

Two production call sites unconditionally called `terminalizeCycleAtRunEnd({ runId })` on
`kind === 'failure'`, without checking whether execution had actually begun — even though A1
already computes exactly that signal (`hasExecutionStarted(runId)`, captured before the terminal
UPDATE) at both sites, previously used only to gate the ibrain assertion:

- `transitionRunToBlocked` — `if (kind === 'failure') { this.terminalizeCycleAtRunEnd({ runId }); ... }`
- `startRunDetached`'s background `.catch` — called `terminalizeCycleAtRunEnd` immediately after the
  CAS UPDATE succeeded, with no execution-state check at all.

`terminalizeCycleAtRunEnd` → `cycleService.setCyclePhase(cycleId, 'complete')`, which both
permanently sets `cycles.phase = 'complete'` and (via `FREEZE_ON_OR_AFTER` in `cycle-service.ts`)
stamps an immutable `cycle_topology_freezes` row — the schema's `BEFORE UPDATE/DELETE … RAISE(ABORT)`
triggers make that genuinely irreversible without manual SQL. A run that failed during planning was
therefore dragging its entire cycle into a frozen terminal state it could never leave normally.

## Mechanism

Wrapped both existing `terminalizeCycleAtRunEnd` calls in `if (executionStarted) { ... }`, reusing
each site's already-captured `executionStarted` local — no new predicate, no signature change:

- `transitionRunToBlocked`: the wrap sits inside the existing `if (kind === 'failure')` block, so
  operator-pause (`kind === 'operator-pause'`) is unaffected — it never entered that block at all.
  `finalizeRunWorkerRuntimes` and the (already-gated) ibrain assertion below it are untouched.
- `startRunDetached`'s `.catch`: the wrap sits right after the CAS `casApplied` check, before the
  worker-finalize/ibrain-assertion IIFE, which is unchanged.

Left untouched (out of scope, both by brief and by design):
- The true-success completion tail (`terminalizeCycleAtRunEnd({ runId })` after real task
  execution) — a genuine terminal, no gating needed.
- `stopRun`'s operator-STOP path, which also calls `terminalizeCycleAtRunEnd({ runId })`
  unconditionally with its own comment ("operator stop is a true terminal — board must not stay
  planning/implementation", A7/R3.15). This is a deliberate prior decision for an *operator-initiated*
  stop, not an automatic failure classification, and the brief's Observed/plan-row text names only
  `transitionRunToBlocked` (`:393`). Flagging for awareness, not fixed here.

## Files changed

| Path | Action |
|------|--------|
| `src/services/run-orchestrator-service.ts` | **EDIT** — two `if (executionStarted)` wraps around existing `terminalizeCycleAtRunEnd` calls |
| `src/services/run-orchestrator-planning-cycle-a4.test.ts` | **ADD** — 5 dedicated tests |

## Commands run

```bash
HELM_DB_PATH=/tmp/helm-a4-$$.db npx vitest run src/services/run-orchestrator-planning-cycle-a4.test.ts
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts   # must stay 3
npx tsc --noEmit -p tsconfig.json
```

## Newly discovered collateral (flagging, not fixed here — inherited from A2, not caused by A4)

Running A1's own gate file (`src/services/run-orchestrator-planning-terminal-a1.test.ts`) alongside
A4's change surfaced **2 pre-existing failures that predate A4** — confirmed by isolating A4's diff
(see `test-report.md`): both "regression: an executing-phase failure still calls
assertImplementationBrainComplete and finalizes a genuine ibrain row" cases
(`transitionRunToBlocked` and `startRunDetached`) assert `ibrainWorkerRows(runId)).toHaveLength(1)`
after the assertion fires — but neither test pre-inserts a `worker_runtimes` row, so they depend on
A2's now-deleted register-if-needed path to synthesize one. This is the exact same root cause A2
already flagged in `src/a15-worker-finalize.test.ts`, just in a second file A2's own review didn't
enumerate. Not fixed here: `run-orchestrator-planning-terminal-a1.test.ts` is A1's already-VERIFIED
deliverable, out of A4's `run-orchestrator-service.ts`-plus-new-test-only scope. Both files need the
same integration-wave update (assert-a-real-row-first instead of relying on synthesis) — surfacing
this now so `I-P0` picks up both, not just the one A2 already named.

## Out of scope (intentionally)

- `worker-runtime-finalize.ts` — not touched, per brief's explicit instruction.
- `src/index.ts`, cycle schema, topology-freeze schema — not touched.
- `stopRun`'s operator-STOP terminalization — flagged above, not this slice.
- `src/services/run-orchestrator-planning-terminal-a1.test.ts` — flagged above, not this slice
  (another batch's already-closed deliverable).
