# Batch A5 — test-report.md

## New dedicated A5 test file

`src/services/planning-phase-reap-before-finalize-a5.test.ts`

Required command:

```
HELM_DB_PATH=/tmp/helm-a5-$$.db npx vitest run src/services/planning-phase-reap-before-finalize-a5.test.ts
```

Result: **3/3 passed** (4.6s).

1. `agreed:true — reaps plancore + partner handles while their rows are still running, before finalize
   marks them done` — spies on `transport.reap`, and at the instant it fires reads the seat's
   `worker_runtimes.state` directly from the DB. Asserts `state === 'running'` at that instant (proves
   reap ran BEFORE `finalizeWorkerRuntime` flips it to `'done'`), then asserts both rows end `'done'`
   with non-null `ended_at`, and that every reaped handle corresponds to a row. `reapCalls.length === 2`
   (plancore + 1 partner), each with `reason === 'planning-phase-complete'`.
2. `agreed:false — reaps plancore + partner handles while their rows are still running, before finalize
   marks them reaped` — same ordering proof on the blocked/timeout exit; both rows end `'reaped'` with
   non-null `ended_at`; `reason === 'planning-not-agreed'`.
3. `idempotent: reaping an already-reaped handle a second time does not throw and leaves it reaped` —
   calls `transport.reap` a second time on a handle the phase already reaped; resolves without throwing
   and does not add a duplicate `reapCalls` entry (both `FakeTransport.reap` and `RealTransport.reap`
   are no-ops on an already-reaped handle).

## Regression check — existing suites unaffected

```
HELM_DB_PATH=/tmp/helm-a5-verify-$$.db npx vitest run src/services/planning-phase-service.test.ts src/a0-convene-race-regression.test.ts
```

Result: **36/36 passed** (22.9s) — no existing test asserts an exact `reapCalls.length`, so the new
reap-before-finalize calls added no regressions.

## Standing-rule check

```
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts
```

Result: `3` (unchanged — A0's pin still holds).

## Type check

`npx tsc --noEmit -p .` — no errors reported against `planning-phase-service.ts` or the new test file.
