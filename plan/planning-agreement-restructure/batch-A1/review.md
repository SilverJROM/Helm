# A1 review.md (implementer self-review)

**Batch:** A1
**Verdict:** READY FOR VALIDATOR

## Scope discipline

- [x] Edits confined to `src/services/run-orchestrator-service.ts`
- [x] One new dedicated test file: `src/services/run-orchestrator-planning-terminal-a1.test.ts`
- [x] Zero edits to `src/index.ts`, schema, or cross-stream files
- [x] Zero edits to `real-transport.ts` (C1's file, running concurrently) or
      `worker-runtime-finalize.ts` (A2's file, next in the chain)
- [x] `finalizeRunWorkerRuntimes` calls at both sites are unconditional/unchanged — only the
      `assertImplementationBrainComplete` call is newly gated

## Invariant coverage

| Invariant | How proven |
|-----------|------------|
| Pre-terminal state captured before the phase-overwriting UPDATE | `hasExecutionStarted(runId)` called immediately before each terminal `UPDATE runs SET phase=...`, in both `transitionRunToBlocked` and `startRunDetached`'s catch |
| Planning-only failure never asserts ibrain complete | Test cases 1 & 3: `assertImplementationBrainComplete` spy not called; 0 `worker_runtimes` rows with `role='ibrain'` |
| No synthesized ibrain completion | Same cases — a positive DB read (`ibrainWorkerRows`) proves no register-if-needed INSERT fired, not just an unasserted spy |
| Genuine execution failure cleanup unweakened | Test cases 2 & 4 (regression): assertion fires exactly once, a real `ibrain` row is finalized, when phase='executing' + run_tasks exist |
| Existing B04 generation-CAS behavior intact | `run-orchestrator-service.test.ts -t "B04"`: 9/9 green, including two cases that already asserted the ibrain finalize DOES fire on a current-generation run |

## Risks / residual

- `hasExecutionStarted` is a new private method reached via two duplicate `const executionStarted =
  ...` capture sites rather than a single shared call — acceptable: the two call sites differ in
  when they're allowed to skip (`transitionRunToBlocked` only cares when `kind === 'failure'`;
  `startRunDetached`'s catch is unconditionally a failure path), and the brief scoped this to
  exactly these two sites, not a refactor.
- The `run_tasks` count signal only matters if a future caller can somehow have `run_tasks` rows
  while `runs.phase` is still `starting/interview/planning` (e.g. a resume/replay edge case not
  exercised by current production code paths). Current tests exercise the `phase`-only signal
  directly (cases 1–4); the count fallback is defensive per the brief's explicit call-out, not
  independently unit-proven in isolation — flagging for validator awareness, not blocking.
- Tests spy on the private `assertImplementationBrainComplete` via `(orch as any)`, following the
  existing project convention (`p1-6b.test.ts`, `planning-phase-service.test.ts`,
  `dispatch-service.test.ts` all do the same for private methods).

## Proof commands for validator

```bash
HELM_DB_PATH=/tmp/helm-a1-$$.db npx vitest run src/services/run-orchestrator-planning-terminal-a1.test.ts
HELM_DB_PATH=/tmp/helm-a1-verify2-$$.db npx vitest run src/services/run-orchestrator-service.test.ts -t "B04"
```

## Done criteria vs brief

All expected acceptance criteria from `A1.implementer.brief.md` met:
- Pre-terminal execution state captured before the blocked UPDATE — done.
- `assertImplementationBrainComplete` gated to skip on planning-only failure at both named call
  sites (`:390-414`-equivalent, `:492`-equivalent post-edit) — done.
- Genuine execution failure cleanup not weakened — proven by regression cases + B04 suite.
- One new dedicated A1 unit-test file, no synthesized ibrain completion — done.
- Scope held to `run-orchestrator-service.ts` + new test/artifacts only — done.
- Gate command green — done.

Artifacts written under `plan/planning-agreement-restructure/batch-A1/`.
