# A3 review.md (implementer self-review)

**Batch:** A3
**Verdict:** READY FOR VALIDATOR

## Scope discipline

- [x] Edits confined to `src/services/worker-runtime-finalize.ts`
- [x] One new dedicated test file: `src/services/worker-runtime-finalize-a3.test.ts`
- [x] Zero edits to `run-orchestrator-service.ts`, `src/index.ts`, schema, or any cross-stream file
- [x] `HELM_SESSION_JANITOR` not referenced or modified
- [x] No signature change to `assertRegistryIdle`, `finalizeWorkerRuntimeRow`, or
      `finalizeBrainSessionRow` — the fix is entirely inside the SELECT's JOIN predicate

## Invariant coverage

| Invariant | How proven |
|-----------|------------|
| Registry idle asserted only for the helm session row owned by the same run/runtime identity | JOIN predicate `s.run_id IS wr.run_id` added; test case 1 proves a same-name unrelated live session (different `run_id`) is left `active` |
| Existing CAS token flow / best-effort behavior preserved | `sessionStatusTokenFromRow` call and surrounding `try/catch` untouched; test case 2 proves the real `SessionRegistryService.markIdle` CAS write still succeeds for the matching case |
| Missing/non-matching run-owned session → no-op, not throw | Row absent from JOIN result → falls into the pre-existing `if (!row?.name) return;` guard, unchanged; test case 1's `finalizeWorkerRuntimeRow` call still returns `true` (runtime row transitions fine) with no exception |
| `HELM_SESSION_JANITOR` untouched | Not referenced in the diff; grep confirms zero occurrences added |
| Null-run_id (ad-hoc worker) case not regressed | `IS` (null-safe) instead of `=`; test case 3 proves both-NULL still matches and marks idle |

## Risks / residual

- **Design choice flagged for validator:** `IS` performs an exact match including the both-NULL
  case. If a future caller ever needs "any worker_runtimes row with a NULL run_id should be able to
  idle ANY helm_sessions row regardless of that row's run_id" (not the case observed anywhere in
  this codebase), this predicate would refuse that. Current production `worker_runtimes` INSERT
  sites either always set a concrete `run_id` (`orchestrator-loop.ts`, `planning-phase-service.ts`)
  or reflect it faithfully as `null` for genuinely run-less workers (`worker-service.ts`), so exact
  match is the correct fail-closed behavior per AC3's "must not mark unrelated session idle."
- Collateral (inherited from A2, not introduced by A3): `src/a15-worker-finalize.test.ts` still has
  4 failing assertions from the register-if-needed removal. Confirmed A3 adds zero new failures to
  that file (identical 4-failed/16-passed count before and after this diff) — see `test-report.md`.
  That file remains integration-owned per WAVE-PLAN.md, not edited here.
- No change to `finalizeRunWorkerRuntimes`, `finalizeSessionGoneWorkers`, or
  `finalizeBrainSessionRow` — all untouched, confirmed by diff; A3's predicate lives entirely
  inside the private `assertRegistryIdle` helper.

## Proof commands for validator

```bash
HELM_DB_PATH=/tmp/helm-a3-$$.db npx vitest run src/services/worker-runtime-finalize-a3.test.ts
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts   # must stay 3
npx tsc --noEmit -p tsconfig.json
```

## Done criteria vs brief

All expected acceptance criteria from `A3.implementer.brief.md` met:
- `assertRegistryIdle` tightened to bind on run-owned identity, not name alone — done.
- Existing CAS token flow (`sessionStatusTokenFromRow`) and best-effort behavior preserved — done.
- Missing/non-matching run-owned session → no-op, no throw, no unrelated session marked idle — done.
- `HELM_SESSION_JANITOR` not enabled or modified — done.
- One new dedicated A3 unit-test file: same-name-unrelated-live-session-not-idled +
  matching-run-owned-session-still-idled — done (plus a third case for the null-safety design
  choice).
- Scope held to `worker-runtime-finalize.ts` + new test/artifacts only — done.
- Gate command green — done.
- Raceguard count stays 3 — done.

Artifacts written under `plan/planning-agreement-restructure/batch-A3/`.
