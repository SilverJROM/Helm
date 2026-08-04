# test-report.md — B5

## Dedicated B5 gate

```
HELM_DB_PATH=/tmp/helm-b5-$$.db npx vitest run src/services/planning-phase-current-plan-sha-b5.test.ts
```

**Result:** 4/4 passed.

Coverage (matches the brief's required proof + acceptance criteria verbatim):
- **Required proof from north:** seat A CLEAN on revision R1, `plan.md` changes to R2, seat B
  CLEAN on R2 → gate REFUSES (A never reviewed R2), observed on a bounded short timeout
  (200ms), proving deterministic refusal rather than a hang.
- All configured seats CLEAN for the current R2 `short12` plus `PLAN-READY` → gate PASSES.
- CLEAN with a missing `plan=` field, and separately CLEAN with a well-formed but
  superseded/nonmatching `plan=<sha12>` → neither counts as agreement (two sub-cases in one
  test).
- A BROKEN verdict remains dispositive under the existing raceguard behavior (plan.md present
  and non-empty → fails fast, well under a 5s timeout).

## Regression sweep (targeted gates — A0/A5/A6/B1/B2/B3/B4/B5)

```
HELM_DB_PATH=/tmp/helm-b5-targeted-$$.db npx vitest run \
  src/a0-convene-race-regression.test.ts \
  src/services/planning-phase-reap-before-finalize-a5.test.ts \
  src/services/planning-phase-one-terminal-owner-a6.test.ts \
  src/services/plan-revision-b1.test.ts \
  src/services/brief-writer-panel-plan-contract-b2.test.ts \
  src/services/planning-phase-verdict-parser-b3.test.ts \
  src/services/planning-phase-newest-verdict-b4.test.ts \
  src/services/planning-phase-current-plan-sha-b5.test.ts
```

**Result:** 8 files, 41/41 tests passed.

## Typecheck

```
npx tsc --noEmit -p .
```

**Result:** clean, no errors.

## Race-guard pin

```
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts
```

**Result:** `3` (unchanged before and after edit — verified after every edit pass, not just
at the end).

## Collateral evidence — `planning-phase-service.test.ts` (base suite, not part of B5's gate)

Pre-B5 baseline (`git stash` on just `src/services/planning-phase-service.ts`, file run alone):

```
HELM_DB_PATH=/tmp/helm-b5-base-$$.db npx vitest run src/services/planning-phase-service.test.ts
```
**Result:** 31/31 passed (21.9s). Note: `POCFIX8 (a)` alone already ran in 12190ms against a
12000ms window even at baseline — it resolves via the outer-timeout race-guard-suppression
path, not a fast BROKEN/CLEAN decision.

Post-B5 (file run alone):

```
HELM_DB_PATH=/tmp/helm-b5-base-suite-$$.db npx vitest run src/services/planning-phase-service.test.ts
```
**Result:** 9/31 passed, 22/31 failed.
- Root cause: `POCFIX8 (a)` hand-drives a `CLEAN: consensus reached` line with no `plan=`
  while running the real (`!isFake`) path, which now enforces the SHA bind — the wait never
  resolves `true`, vitest's per-test timeout abandons the still-pending `await p`, and the
  test's own `try { ... } finally { restore USE_FAKE_TMUX/HELM_PLANNING_TIMEOUT_MS }` never
  runs (the abandoned promise means the function body never reaches `finally`).
- Cascade: the leaked `USE_FAKE_TMUX='0'` causes every later test's `beforeEach` (`new
  FakeTransport()`) to throw ("FakeTransport strictly behind USE_FAKE_TMUX=1"), accounting for
  the other 21 failures.
- This file is the shared base regression suite, not one of B5's required gates, and per the
  coordinator's explicit instruction (`[projcore] REVISE-PLAN B5`, 2026-07-30T02:20:14Z) it was
  left unedited rather than patched out-of-scope. See `changes.md` → "Collateral" for the full
  mechanism writeup and the proposed (unapplied) one-line fix.
