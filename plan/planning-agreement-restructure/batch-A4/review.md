# A4 review.md (implementer self-review)

**Batch:** A4
**Verdict:** READY FOR VALIDATOR

## Scope discipline

- [x] Edits confined to `src/services/run-orchestrator-service.ts`
- [x] One new dedicated test file: `src/services/run-orchestrator-planning-cycle-a4.test.ts`
- [x] Zero edits to `src/index.ts`, cycle schema, topology-freeze schema, or `worker-runtime-finalize.ts`
- [x] Zero edits to `src/services/run-orchestrator-planning-terminal-a1.test.ts` (A1's file, even
      though A4's own regression run surfaced pre-existing failures in it — see below)
- [x] `finalizeRunWorkerRuntimes` calls at both sites are unconditional/unchanged — only the
      `terminalizeCycleAtRunEnd` call is newly gated

## Invariant coverage

| Invariant | How proven |
|-----------|------------|
| Planning-only failure does not terminalize the cycle | `if (executionStarted)` wraps `terminalizeCycleAtRunEnd` at both call sites; test cases 1 & 4: cycle stays `'planning'`, zero `cycle_topology_freezes` rows |
| No topology freeze on planning-only failure | Same cases — positive DB read of `cycle_topology_freezes`, not just an unasserted phase |
| Genuine execution failure still terminalizes | Test cases 2 & 5 (regression): cycle flips to `'complete'`; case 2 additionally proves the freeze stays idempotent (count `1`, not `0` or `2`) when the cycle was already frozen on entering `implementation` |
| Operator-pause remains non-terminal, unweakened | Test case 3: `kind='operator-pause'` on an executing run still leaves the cycle at `'planning'` — it was never in scope of the `kind === 'failure'` block, and stays that way |
| Run's own terminal transition (`phase='blocked'`/`'failed'`) unaffected by the cycle gate | All 5 cases assert `runs.phase`/`status` land correctly regardless of cycle outcome |

## Risks / residual

- **Newly discovered collateral, not fixed here:** running A1's gate file alongside this batch's
  change surfaced 2 pre-existing failures in `run-orchestrator-planning-terminal-a1.test.ts`
  (both "regression: executing-phase failure... finalizes a genuine ibrain row" cases). Isolated
  and confirmed this is caused by A2's `finalizeBrainSessionRow` update-only change (the same root
  cause already documented for `src/a15-worker-finalize.test.ts`), **not by A4** — see
  `test-report.md`'s isolation steps. Flagging because it's a second file beyond the one A2's own
  review named, so the integration wave reconciling capstone/gate tests should pick up both.
- `stopRun`'s operator-STOP path (`:2368-2438`) also unconditionally calls
  `terminalizeCycleAtRunEnd` — a deliberate A7/R3.15 decision for an operator-initiated stop,
  outside this brief's named scope (`transitionRunToBlocked` / plan-row `:393`). Flagged in
  `changes.md`, not touched.
- The two `if (executionStarted)` wraps are duplicated per call site rather than extracted into a
  shared helper — consistent with A1's own stated rationale for not sharing its
  `hasExecutionStarted` capture logic (the two sites differ in surrounding control flow: one is
  inside an existing `kind === 'failure'` conditional, the other stands alone right after a CAS
  check) and with this brief's narrow scope (two `if` wraps, not a refactor).

## Proof commands for validator

```bash
HELM_DB_PATH=/tmp/helm-a4-$$.db npx vitest run src/services/run-orchestrator-planning-cycle-a4.test.ts
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts   # must stay 3
npx tsc --noEmit -p tsconfig.json
```

## Done criteria vs brief

All expected acceptance criteria from `A4.implementer.brief.md` met:
- Gate cycle terminalization so planning-only failure paths do not call `terminalizeCycleAtRunEnd`
  — done, both call sites.
- Preserve terminalization for genuine execution failures and true success terminals — done
  (regression cases; true-success tail untouched).
- Operator-pause remains non-terminal for cycles — done, proven not just assumed.
- No edits to cycle schema, topology freeze schema, `src/index.ts`, or `worker-runtime-finalize.ts`
  — done.
- One new dedicated A4 unit-test file, planning-only-retryable + executing-still-terminalizes at
  both call sites — done (5 cases: 2 required scenarios × 2 call sites + 1 operator-pause guard).
- Scope held to `run-orchestrator-service.ts` + new test/artifacts only — done.
- Gate command green — done.
- Raceguard count stays 3 — done.

Artifacts written under `plan/planning-agreement-restructure/batch-A4/`.
