# Batch A5 — review.md

## Self-review verdict: PASS

## Acceptance criteria checklist

- [x] **Retain each planning seat transport handle needed for terminal cleanup.**
      `plancoreHandle` (overwritten per spawn attempt, final surviving handle) + `partnerHandles[]`
      (one per spawned partner) added alongside the existing runtime-id vars.
- [x] **Transport cleanup (`transport.reap(handle, ...)`) happens before any DB finalize for planning
      workers on the covered exit path.** Both existing terminal exits (`agreed:false` blocked/timeout,
      `agreed:true` success) now `await this.reapPlanningHandle(...)` for every retained handle
      immediately before the existing `finalizeWorkerRuntime` calls. Proven in the new test via
      DB-state-at-reap-time (state is still `'running'` at the instant `reap` fires), not just call order.
- [x] **Cleanup must be idempotent.** `reapPlanningHandle` is try/catch best-effort; `FakeTransport.reap`
      and `RealTransport.reap` (read-only inspection, not edited) are both no-ops on an already-reaped
      handle. Covered by the new "idempotent" test case (second reap on the same handle: no throw, no
      duplicate `reapCalls` entry).
- [x] **One new dedicated A5 unit-test file proving reap-before-finalize ordering with `FakeTransport`.**
      `src/services/planning-phase-reap-before-finalize-a5.test.ts`, 3/3 green.
- [x] **Stay within `src/services/planning-phase-service.ts` plus new test/artifacts only.** Diff touches
      only that file (+33 lines, 0 removed) plus the new test file and this batch's three artifacts.
      `real-transport.ts` (C1's file) and `src/index.ts` untouched — read-only inspection only.
- [x] **`HELM_DB_PATH=/tmp/helm-a5-$$.db npx vitest run <new-test-file>`** — 3/3 passed, see test-report.md.
- [x] **`grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts` remains `3`.** Verified.

## Standing rules checklist

- [x] Never invent a schema version — no schema changes.
- [x] Never edit `src/index.ts` — untouched.
- [x] Cross-stream type changes additive/optional only — no exported type/signature changed.
- [x] Never edit a file another stream owns — `real-transport.ts` (C1) untouched.
- [x] Gate is the own new unit-test file — used, green.
- [x] The invariant lives in code/tests, not prose — reap-before-finalize is enforced by code ordering
      at both exits and proven by a DB-state assertion in the test, not a comment claim.

## Risk / regression check

- Existing `planning-phase-service.test.ts` (31 tests) + `a0-convene-race-regression.test.ts` (5 tests):
  36/36 still green after the change — no test asserted an exact `reapCalls.length`, so adding the two
  new reap-before-finalize call sites did not perturb any existing assertion.
- `npx tsc --noEmit -p .` reports no errors against the touched file or the new test file.

## Explicitly deferred (not a gap in A5's own scope)

- The spawn-retry loop's `throw new Error(...)` exit (retries exhausted, no first callback ever
  received) is not routed through reap-before-finalize by this batch — A6 ("one terminal owner")
  is the slice that unifies success/blocked/thrown exits under a single transport-first `try/finally`.
- The reconvene-on-conflict path (`reconveneConflictingTasks`) spawns its own short-lived seats and
  registers their runtime rows, but does not retain/reap their handles either — out of A5's scope
  (plan.md's A5 row cites only the plancore/partner spawn sites at lines 454 and 536-549).
