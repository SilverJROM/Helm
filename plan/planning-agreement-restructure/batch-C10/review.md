# review.md — Batch C10 (implementer self-check)

**Verdict:** READY for independent validator
**AC16:** Persist accepted plans transactionally — normalize/validate fully before any DB write; task
rows + artifact metadata + queue admission commit or roll back together.

## Checklist

| Check | Status |
|-------|--------|
| Only `plan-parser-service.ts` + new `plan-parser-service-c10.test.ts` touched | Yes |
| Normalize/validate the entire plan before any DB write | Yes — unchanged ordering (`validateMachinePlan` → `ingestValidator` → `resolveTaskBatches` → `validateBatchDependencies`), all still precede the transaction |
| Task rows + artifact row + enqueue side effects persist as one transaction: all or none | Yes — `recordTask`×N + `recordArtifact` + `queue.enqueue`×N all run inside one `db.raw.transaction` callback |
| Injected mid-ingest **DB** failure rolls back all task/artifact/queue side effects | Yes — dedicated test (case 2): 0 rows, 0 queue entries |
| Injected mid-ingest **queue** failure (the gap projcore's REVISE-PLAN flagged) also rolls back cleanly | Yes — dedicated test (case 3): enqueue runs inside the same transaction callback (its throw rolls back the SQL side too); the outer `try/catch` compensates any already-applied in-memory `enqueue` mutations via `queue.clearRun(runId)` before rethrowing |
| Success-path test proving normal ingest still persists tasks/deps/artifact metadata | Yes — case 1, plus the full pre-existing `plan-parser-service.test.ts` suite (13/13) |
| No schema version invented | Yes — `run_tasks`/`artifacts` already have every column needed; v113 not used |
| Targeted vitest on the new C10 test file | PASS — 4/4 |
| `npx tsc --noEmit -p tsconfig.json` | PASS (whole project) |
| Never edit `src/index.ts` in a build slice | Yes — not touched |
| Never edit a file another stream owns | Yes — `planning-review-round.ts`, `planning-phase-service.ts`, `brief-writer-service.ts` untouched |
| Cross-stream type changes additive/optional only | N/A — no exported type shape changed (`Plan`/`PlannedTask` untouched; `ingestPlan`/`ingestExecutionPlan` signatures and return shapes unchanged) |
| Re-verify slices sharing a file/boundary with anything landed since they were verified | C10 owns `plan-parser-service.ts` alone (WAVE-PLAN.md ownership table); no other landed slice touches it. Re-ran the file's own prior gate (13/13 PASS) and the shared raceguard invariant on `planning-phase-service.ts` (count still 3, file untouched) |

## Incidental fix folded in

`ingestExecutionPlan` previously wrote `plan.json` + recorded a `type='plan'` artifact row itself, then
called `ingestPlan`, which repeated both — every execution-plan ingest recorded **two** `artifacts` rows
for the same snapshot. This duplicate-write path had to be removed anyway to make `ingestPlan` the single
transactional owner of that persistence step (otherwise the now-removed direct write in
`ingestExecutionPlan` would sit entirely outside the transaction, defeating the point). Covered by a
dedicated test (case 4: exactly 1 `artifacts` row of `type='plan'` per exec-plan ingest). No behavior
other than the row count changed — the FS content written is identical either way.

## Design note: why the FS `plan.json` write stays outside the transaction

The brief's acceptance criteria describe DB rows and queue side effects as the all-or-none unit ("either
all rows land or none do"); the FS write was already documented in the pre-C10 code as a defensive,
best-effort convenience for callers/tests that ingest directly (production's real path — the planning
phase — writes `plan.json` to `runDir` *before* calling ingest). Moving it after the transaction commit
means a filesystem failure there can never roll back already-committed, correct DB/queue state; keeping
it non-fatal preserves the exact behavior existing tests already depend on (several construct `runDir`
fresh and rely on this write to read the roundtripped plan back).

## Residual note (pre-existing, not this slice's scope)

Re-running `planning-phase-service.test.ts` (a caller of `ingestExecutionPlan`, not one of C10's own gate
files) as extra due diligence shows the same pre-existing `USE_FAKE_TMUX` cascade flake already documented
in `batch-C2/review.md` (a 12s timeout in `POCFIX8 (a)` whose `finally` never restores the env var,
cascading into ~21 further failures in that file). **Verified via `git stash`** that it reproduces
identically without the C10 edit. Not fixed here — same rationale as C2: out of this slice's
single-file allowlist, and already flagged once for separate triage.

## Evidence

See `test-report.md` and `changes.md`.
