# Batch A6 — changes.md

**Batch:** A6 — One terminal owner (route success, blocked, and thrown planning exits through one
transport-first try/finally; delete the legacy single-brain-only cleanup asymmetry)
**Requirements:** AC5, AC23
**Scope:** `src/services/planning-phase-service.ts` (edit) + new test/artifacts only.

## Root cause (mechanism-level)

After A5, `runPlanningPhase` had three exit families but only two were covered:

1. **Success** (`agreed:true`, ~line 748) — reaped `plancoreHandle` + all `partnerHandles`, then
   finalized `plancoreRuntimeId` + all `partnerRuntimeIds` as `'done'`.
2. **Blocked** (`agreed:false`, ~line 705) — reaped + finalized the same way as `'reaped'`.
3. **Thrown exits** — NOT uniformly covered. The spawn-retry loop's own throw (line 494, fires
   *before* any partner spawn) has an inline plancore-only reap+finalize immediately before it
   (necessary per-attempt respawn hygiene, not a terminal-owner call). But every throw that can occur
   **after** partner seats are spawned — most concretely `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN`
   (raised when `plancore` never authors a valid canonical `plan.md`/`og-requirements.md`), and
   equally any exception from `waitForAgreement`, `materializeCanonicalArtifactSet`, `createRun`,
   `ingestExecutionPlan`, `collectTaskVerdicts`, or `reconveneConflictingTasks` — had **zero** cleanup.
   Both the plancore AND partner transport sessions leaked, and their `worker_runtimes` rows stayed
   `'running'` forever. This is the "single-brain-only cleanup asymmetry": only the pre-partner-spawn
   throw had any cleanup at all (and only for the one seat that existed at that point); every
   partner-bearing thrown exit had none.

## Fix

- Introduced **one local terminal owner** in `runPlanningPhase`, declared right after the existing
  `plancoreHandle`/`partnerHandles` retained-handle declarations:
  ```ts
  let terminalReason = 'planning-thrown-exit';
  let terminalState: 'done' | 'reaped' | 'failed' = 'failed';
  const runPlanningTerminal = async (): Promise<void> => {
    await this.reapPlanningHandle(plancoreHandle, terminalReason);
    for (const h of partnerHandles) await this.reapPlanningHandle(h, terminalReason);
    this.finalizeWorkerRuntime(plancoreRuntimeId, terminalState, terminalReason);
    for (const id of partnerRuntimeIds) this.finalizeWorkerRuntime(id, terminalState, terminalReason);
  };
  ```
  Reap-all-then-finalize-all order is byte-identical to A5's established ordering. Both helpers it
  calls (`reapPlanningHandle`, `finalizeWorkerRuntime`) were already best-effort/never-throw/idempotent
  (A5), so this owner itself can never throw and can never mask a real error.
- Wrapped the rest of the method (the spawn-retry loop through the final success `return`) in one
  `try { ... } catch (err) { ...; throw err; } finally { await runPlanningTerminal(); }`:
  - **Blocked exit:** sets `terminalReason = 'planning-not-agreed'; terminalState = 'reaped';` and
    deletes the now-redundant inline reap+finalize calls that used to sit right there — the `finally`
    performs that work.
  - **Success exit:** sets `terminalReason = 'planning-phase-complete'; terminalState = 'done';` and
    deletes its own now-redundant inline reap+finalize calls, same reasoning.
  - **Thrown exit:** `catch (err)` sets `terminalReason = 'planning-thrown-exit: ' + err.message` and
    `terminalState = 'failed'`, then **rethrows the original `err` unchanged** — the error is never
    masked. `finally` then runs the same owner regardless of which branch was taken.
- The pre-existing per-attempt inline reap+finalize inside the spawn-retry loop (tears down a
  *discarded* respawn attempt while the loop keeps retrying — not a terminal exit) is intentionally
  left untouched; it is orthogonal to A6's terminal-exit scope. When that loop's own final-attempt
  throw propagates, the outer `finally` redundantly (but harmlessly) re-invokes the owner on the
  already-reaped/already-finalized plancore seat — confirmed safe because `transport.reap` and
  `finalizeWorkerRuntimeRow` are both documented no-ops on an already-terminal target.
- No exit path now bypasses A5: every one of the three exit families runs through the exact same
  `runPlanningTerminal()` call, in the exact same reap-then-finalize order.

## Explicitly out of scope

- `real-transport.ts`, `src/index.ts` — untouched.
- Any change to `waitForAgreement`, the race-guard lines, or an exported type signature.
- The per-attempt spawn-retry cleanup (lines ~491-492) — legitimate mid-loop respawn hygiene, not part
  of the terminal-owner asymmetry.

## Files touched

- `src/services/planning-phase-service.ts` — one local terminal-owner closure + `try/catch/finally`
  wrap + deletion of the two now-redundant inline reap/finalize blocks at the blocked and success
  exits.
- `src/services/planning-phase-one-terminal-owner-a6.test.ts` (new) — see test-report.md.

## Standing rules honored

- `real-transport.ts` untouched (C1's file).
- `src/index.ts` untouched.
- `grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts` still returns `3`.
- No schema changes.
