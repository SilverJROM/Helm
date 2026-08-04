# A3 changes.md — bind assertRegistryIdle to run-owned runtime identity

**Batch:** A3
**Branch:** `fix/planning-agreement-restructure`
**Requirements:** AC3, AC23
**Scope:** `src/services/worker-runtime-finalize.ts` + one new dedicated test file only

## Summary

`assertRegistryIdle` (`worker-runtime-finalize.ts:48-68`) joined `helm_sessions` to the
`worker_runtimes` row being finalized by session **name alone**. Persistent master sessions
(`helm-ibrain-<slug>`) are reused across runs of the same project, and
`SessionRegistryService.register()` upserts `helm_sessions.run_id` to whichever run most recently
re-registered that name (`run_id = COALESCE(excluded.run_id, helm_sessions.run_id)`,
`session-registry-service.ts:186`). A stale, non-terminal `worker_runtimes` row from an earlier,
already-failed run could therefore be finalized *after* the session name had been re-registered to
a new, unrelated, still-live run — the name-only join would fetch that live session's *current*
row and hand it to `markIdle`, incorrectly idling a session a different run still owns.

## Mechanism

Added a run-identity predicate to the existing JOIN:

```sql
JOIN helm_sessions s ON s.name = wr.session AND s.run_id IS wr.run_id
```

Used SQLite's null-safe `IS` rather than `=`: `worker_runtimes.run_id` can legitimately be `NULL`
for ad-hoc no-run-context workers (`worker-service.ts:187`, `runId ?? null`), and plain `=` against
`NULL` is never true in SQL — that would have silently turned every no-run-context finalize into a
markIdle no-op, a behavior change outside this slice. `IS` matches non-null-vs-non-null exactly
(closing the race) and null-vs-null (preserving today's behavior for that existing case)
uniformly. On a mismatch the row is simply not returned by the SELECT; the pre-existing
`if (!row?.name) return;` guard already makes that a clean no-op — no throw, no session touched.

No signature change: `assertRegistryIdle(db, id, reason)` is unchanged: `wr.run_id` comes from the
same `worker_runtimes` row already being read via `WHERE wr.id = ?`, so no new parameter was
needed. `sessionStatusTokenFromRow` / the CAS token flow is untouched.

## Files changed

| Path | Action |
|------|--------|
| `src/services/worker-runtime-finalize.ts` | **EDIT** — one-line JOIN predicate added in `assertRegistryIdle`, plus a comment explaining the race and the null-safety choice |
| `src/services/worker-runtime-finalize-a3.test.ts` | **ADD** — 3 dedicated tests |

## Commands run

```bash
HELM_DB_PATH=/tmp/helm-a3-$$.db npx vitest run src/services/worker-runtime-finalize-a3.test.ts
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts   # must stay 3
npx tsc --noEmit -p tsconfig.json
```

## Out of scope (intentionally)

- `run-orchestrator-service.ts` — not touched, per brief's explicit instruction (A3 stays on this
  seat's file only, unlike A1/A4 which own the orchestrator).
- `src/index.ts`, schema, `HELM_SESSION_JANITOR` — not touched.
- `finalizeBrainSessionRow` (A2's update-only change) — untouched; A3 only affects the markIdle
  propagation step inside `finalizeWorkerRuntimeRow`, which `finalizeBrainSessionRow` calls into
  unmodified.
- `src/a15-worker-finalize.test.ts` — already failing 4/20 from A2's collateral (see A2's
  `changes.md`); confirmed A3 introduces no *additional* failures there (still 4 failed / 16
  passed, same 4 cases) — see `test-report.md`.
