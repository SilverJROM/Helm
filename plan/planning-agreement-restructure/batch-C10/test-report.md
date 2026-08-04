# test-report.md — Batch C10

**Gate file:** `src/services/plan-parser-service-c10.test.ts`

## Type check

```bash
npx tsc --noEmit -p tsconfig.json
```
**Result:** PASS — no errors, whole project.

## C10 gate (own new unit-test file)

```bash
npx vitest run src/services/plan-parser-service-c10.test.ts
```
**Result:** PASS — 4/4 tests, 1 file, ~180ms.

| # | Case | Result |
|---|------|--------|
| 1 | Success path: normal ingest persists 3 `run_tasks` rows + 1 `artifacts` row (`type='plan'`, `path='plan.json'`) + the FS snapshot, and the queue admits tasks in dependency order (T1 → T2 → T3) | PASS |
| 2 | Rollback (DB failure): `recordTask` spied to throw on the 3rd call → ingest rejects; **0** `run_tasks` rows, **0** `artifacts` rows, **0** queue entries survive for that run | PASS |
| 3 | Rollback (queue failure — the exact gap projcore flagged in REVISE-PLAN): `queue.enqueue` spied to throw on the 3rd call → ingest rejects; the SQL transaction rolled back (because the throw propagated out of the same `db.raw.transaction` callback the enqueue loop runs inside) AND the 2 in-memory `enqueue` calls that already ran before the throw are undone by the `queue.clearRun(runId)` compensation in the outer catch — **0** rows, **0** queue entries | PASS |
| 4 | Duplicate-write fix: `ingestExecutionPlan` on a 1-task exec plan now records exactly **1** `artifacts` row of `type='plan'` (previously recorded 2 — one from `ingestExecutionPlan`'s own now-removed write, one from the `ingestPlan` call it delegates to) | PASS |

## Pre-existing regression suite (own file's prior gate)

```bash
npx vitest run src/services/plan-parser-service.test.ts
```
**Result:** PASS — 13/13 (no regressions from the transactional rewrite or the duplicate-write fix —
these tests already asserted single-write `plan.json` content/queue-order behavior, which is unchanged).

## Shared-boundary re-verification

C10's sole owned file is `plan-parser-service.ts` (per `WAVE-PLAN.md`'s file-ownership table — no other
slice in this run touches it). The only cross-file surface is the private-`db`-field bracket-access
pattern (`this.artifacts['db'].raw`), which is pre-existing (already used by `TaskQueueService` in
`task-queue-service.ts`) and was not modified.

```bash
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts   # == 3 (unchanged, C10 doesn't touch this file)
```
**Result:** 3 — invariant intact.

## Due-diligence run + pre-existing-flake finding (same flake documented at C2)

`npx vitest run src/services/planning-phase-service.test.ts` (a caller of `ingestExecutionPlan`, not one
of C10's own gate files) shows 22/31 failing, all with the same root cause already documented in
`batch-C2/test-report.md`: `POCFIX8 (a): real !fake path uses long waitForAgreement timeout...` times out
at its hardcoded 12s limit, and because its `finally` block (restoring `process.env.USE_FAKE_TMUX`) never
runs on timeout, every subsequent `beforeEach` in that file constructs a `FakeTransport` while
`USE_FAKE_TMUX` has been left at `'0'`.

**Verified via `git stash push -- src/services/plan-parser-service.ts`** (reverting only the C10 edit)
that this exact failure set (same 22 tests, same error) reproduces identically on the pre-C10 baseline —
confirming it predates C10 and is unrelated to this slice. Consistent with the C2 finding of the same
flake. Not touched here (out of the `plan-parser-service.ts`-only allowlist for this slice).

## Outcome

AC16 gate green: normalize/validate fully before any DB write (unchanged ordering, now explicitly
documented); task rows + artifact row + queue admission commit/rollback as one unit, including the
queue-throws-mid-loop case; no schema version invented (v113 unused — `run_tasks`/`artifacts` already
sufficed).
