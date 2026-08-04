# Batch A6 — test-report.md

## New gate test

`src/services/planning-phase-one-terminal-owner-a6.test.ts`

**Command:**
```
HELM_DB_PATH=/tmp/helm-a6-$$.db npx vitest run src/services/planning-phase-one-terminal-owner-a6.test.ts
```

**Result:** 1 passed (1 test file), ~2.2s.

**What it proves:** a THROWN planning exit that occurs *after* the partner seat is already spawned
(the `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN` throw, forced by driving the real/non-fixture branch
while never writing `plan.md`/`og-requirements.md`) still:
1. Rejects with the **original, unmasked** error message (`toThrow(/PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN/)`).
2. Reaps **both** the plancore handle and the partner handle — `transport.reapCalls.length === 2`.
3. Reaps each handle **before** its `worker_runtimes` row is finalized — proven the same way A5 proved
   it: `transport.reap` is spied, and at the instant it fires the spy reads the row's `state` directly
   from the DB; every observed state is `'running'` (not yet terminal).
4. Finalizes both rows to a terminal state (`'failed'`) with a non-null `ended_at` — the thrown exit no
   longer leaves them stuck `'running'` forever.
5. Every reap call's `reason` matches `planning-thrown-exit: ...`, confirming the one terminal owner
   (not the old per-attempt inline cleanup) ran for this exit.

## Regression re-checks

- `src/services/planning-phase-reap-before-finalize-a5.test.ts` — 3/3 passed (success, blocked, and
  idempotent-reap cases from A5 all still green; the blocked/success reap-before-finalize proof is now
  driven by the shared terminal owner instead of per-exit inline calls, with byte-identical ordering).
- `grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts` → `3` (unchanged; A0's pin
  survives).
- `npx tsc --noEmit -p .` → clean, no type errors introduced.
- Broader sweep run for safety: `a0-convene-race-regression.test.ts` (5/5), `cycle-start-planning.test.ts`
  (5/5), `planning-regression-index.test.ts` (2/2 + 7 skipped), `planning-staffing-service.test.ts`
  (4/4), `s10-planning-mode.test.ts` (4/4) — all green, unaffected by this batch.
- `finish-planning-production.test.ts` and `pause-after-planning-gate.test.ts` each showed a failure.
  **Confirmed pre-existing and unrelated to A6**: re-ran both against the pre-A6 baseline (A6's edit to
  `planning-phase-service.ts` stashed) and they fail identically without any A6 change present. Not
  touched or investigated further — out of this batch's scope (owns `planning-phase-service.ts` only
  for this slice).

## Files touched by this batch (recap)

- `src/services/planning-phase-service.ts` (edit)
- `src/services/planning-phase-one-terminal-owner-a6.test.ts` (new)
