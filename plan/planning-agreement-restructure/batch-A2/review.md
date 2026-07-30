# A2 review.md (implementer self-review)

**Batch:** A2
**Verdict:** READY FOR VALIDATOR

## Scope discipline

- [x] Edits confined to `src/services/worker-runtime-finalize.ts`
- [x] One new dedicated test file: `src/services/worker-runtime-finalize-a2.test.ts`
- [x] Zero edits to `src/index.ts`, schema, or cross-stream files
- [x] Zero edits to `run-orchestrator-service.ts` (the only caller) or `src/a15-worker-finalize.test.ts` (integration-owned capstone test)
- [x] No schema version invented

## Invariant coverage

| Invariant | How proven |
|-----------|------------|
| `finalizeBrainSessionRow` only finalizes an existing non-terminal run-linked runtime | Single SELECT for a non-terminal `(run_id, session)` row; the only path that writes is the found-row branch calling the unchanged `finalizeWorkerRuntimeRow` |
| Missing row → `false`, no INSERT | Test case 1: row count for the run stays `0`; no INSERT statement remains in the function at all (code diff) |
| Register-if-missing insert path deleted | Code diff — the `INSERT INTO worker_runtimes` block and its `role`/`provider`/`model` locals are gone |
| `unknown`/`unknown` provider/model fallback defaults deleted | Code diff — `provider = opts.provider \|\| 'unknown'` / `model = opts.model \|\| 'unknown'` deleted; test case 1 positively asserts zero rows anywhere with `provider='unknown' AND model='unknown'` |
| `expectedGeneration` fail-closed behavior preserved | Unchanged code block (:194-205); test case 4 proves it still wins even when a matching non-terminal row now exists to update |
| Idempotent `false` return for already-terminal rows | Test case 2 (pre-terminal row, no resurrection) and case 3's second call |

## Risks / residual

- **Collateral breakage, not fixed here by design:** `src/a15-worker-finalize.test.ts` has 4
  assertions (S03 describe block, cases 1/2/3/5) that assumed the register-if-needed path and now
  fail — see `test-report.md` for the exact lines. This file is one of WAVE-PLAN.md's three
  cross-cutting capstone tests, explicitly integration-owned and reconciled at `I-P2`, and standing
  rule 4/5 forbid touching another stream's file. Flagging so this is not mistaken for an
  unexplained regression when the full suite runs; it needs updating at the integration wave to
  assert the new update-only contract instead of register-if-needed.
- The `opts` type still declares `role`/`provider`/`model` as accepted fields even though the
  function body no longer reads them — kept solely so the untouched caller
  (`run-orchestrator-service.ts:609`, which passes them as an object literal) does not trip a
  TypeScript excess-property error. Acceptable: the brief's scope is this file only, and the
  caller's cleanup (dropping now-meaningless args) is not this slice's concern.
- No change to `finalizeWorkerRuntimeRow`, `assertRegistryIdle`, `finalizeRunWorkerRuntimes`, or
  `finalizeSessionGoneWorkers` — all untouched, confirmed by diff.

## Proof commands for validator

```bash
HELM_DB_PATH=/tmp/helm-a2-$$.db npx vitest run src/services/worker-runtime-finalize-a2.test.ts
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts   # must stay 3
npx tsc --noEmit -p tsconfig.json
```

## Done criteria vs brief

All expected acceptance criteria from `A2.implementer.brief.md` met:
- `finalizeBrainSessionRow` only finalizes an existing non-terminal runtime row for the given
  `runId`/`session` — done.
- No matching row → `false`, no INSERT — done.
- Register-if-missing insert path deleted — done.
- `unknown`/`unknown` provider/model fallback defaults deleted — done.
- `expectedGeneration` fail-closed behavior preserved — done.
- Idempotent `false` return for already-terminal rows preserved — done.
- One new dedicated A2 unit-test file, missing-runtime + positive existing-row cases — done (plus
  two extra cases: already-terminal no-op, expectedGeneration-with-existing-row fail-closed).
- Scope held to `worker-runtime-finalize.ts` + new test/artifacts only — done.
- Gate command green — done.
- Raceguard count stays 3 — done.

Artifacts written under `plan/planning-agreement-restructure/batch-A2/`.
