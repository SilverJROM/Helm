# changes.md — Batch C10

**Batch:** C10 — Persist accepted plans transactionally
**AC:** AC16
**Branch:** `fix/planning-agreement-restructure`
**Date:** 2026-07-30

## Summary

`PlanParserService.ingestPlan` (`plan-parser-service.ts:169-197` pre-change) inserted `run_tasks` rows
one at a time, then wrote the `artifacts` row, then enqueued each task — no transaction, so a failure
partway through left durable orphan rows (tasks with no artifact metadata, or tasks never enqueued).
Ingest now normalizes/validates the whole plan first (unchanged — this already happened before any DB
write), then persists task rows + the plan artifact row + the in-memory queue admission as **one
all-or-none unit**: either every row commits and every task is enqueued, or none of it happens.

Also fixed, in the same file, a latent duplicate-write bug surfaced while making this transactional:
`ingestExecutionPlan` wrote `plan.json` to disk and recorded a `type='plan'` artifact row itself, **then**
called `ingestPlan`, which repeated both writes — every execution-plan ingest recorded two `artifacts`
rows for the same `plan.json`. `ingestExecutionPlan` no longer duplicates either write; `ingestPlan` is
now the single owner of the plan-snapshot persistence path.

## Mechanism

**Before:** `ingestPlan` did, in order, outside any transaction: (1) `forEach` → `recordTask` per task
(N separate `INSERT`s), (2) `fs.writeFile(plan.json)` + `recordArtifact` inside one `try/catch` that
silently swallowed ANY error (FS or DB), (3) `forEach` → `queue.enqueue` per task (in-memory).

**After:**
1. Normalize/validate (unchanged position — `validateMachinePlan`, `ingestValidator`,
   `resolveTaskBatches`, `validateBatchDependencies` all still run first, before any DB write).
2. A single `this.artifacts['db'].raw.transaction(() => {...})()` call wraps: the per-task `recordTask`
   loop, the `recordArtifact` call, **and** the per-task `queue.enqueue` loop — all inside the same
   synchronous callback.
3. `queue.enqueue` is in-memory-only (verified: no DB/FS I/O in `TaskQueueService.enqueue`), so it is
   safe to run synchronously inside the transaction callback. If `recordTask`, `recordArtifact`, or
   `enqueue` throws for *any* task, the exception propagates out of the callback; better-sqlite3 catches
   it, issues `ROLLBACK` (undoing every `run_tasks`/`artifacts` insert made so far in this call), then
   rethrows.
4. That rollback undoes the SQL side but not JS-side mutations `enqueue` already made to the in-memory
   queue for tasks processed *before* the throw. The call site wraps `runTx()` in a `try/catch`; on
   catch it calls `queue.clearRun(runId)` — an existing `TaskQueueService` method that wipes all
   per-run in-memory state — before rethrowing the original error. Net effect: a failure at any point
   leaves **zero** `run_tasks` rows, **zero** `artifacts` rows, and **zero** queue entries for that run.
5. The `plan.json` FS write is now a separate, best-effort step **after** the transaction commits (kept
   non-fatal, same as before) — it was already documented as a defensive convenience for callers that
   ingest directly rather than via the real planning-phase flow (which writes the file itself upstream),
   so it is not part of the DB/queue atomicity contract.
6. `ingestExecutionPlan` no longer performs its own `plan.json` write / `recordArtifact` call — it
   delegates entirely to `ingestPlan`, which now owns that path exactly once.

## Why no schema change

`run_tasks` and `artifacts` already have every column this slice needs (`RunArtifactService.recordTask`
/ `recordArtifact` were already sufficient). No new column or table is required, so **v113 is not used**
— per the brief and `WAVE-PLAN.md`, schema versions are never invented speculatively.

## Files

| File | Change |
|------|--------|
| `src/services/plan-parser-service.ts` | `ingestPlan`: wrap `recordTask`×N + `recordArtifact` + `queue.enqueue`×N in one `db.raw.transaction`; `try/catch` around the transaction call compensates via `queue.clearRun(runId)` on any throw; FS `plan.json` write moved after the transaction, unchanged otherwise. `ingestExecutionPlan`: removed the duplicate `plan.json` write + `recordArtifact` call (delegates to `ingestPlan`). |
| `src/services/plan-parser-service-c10.test.ts` | **New** C10-only gate (4 tests). |

## Explicit non-edits

- `planning-review-round.ts`, `planning-phase-service.ts`, `brief-writer-service.ts`, `src/index.ts` —
  untouched, per brief scope.
- No schema/migration file touched. `SCHEMA_VERSION` unchanged.
- `RunArtifactService` / `TaskQueueService` — untouched. The transaction wrapper reuses
  `this.artifacts['db'].raw` (the same bracket-access-to-the-private-`db`-field pattern already used by
  `TaskQueueService` elsewhere in this codebase, e.g. `task-queue-service.ts:75,91,183`) rather than
  adding a new public method to either service.
- `parsePlanFromJson`, `loadPlanFromRunDir` — untouched.
