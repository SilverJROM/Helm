# changes.md — Batch C2

**Batch:** C2 — Extract the behavior-preserving review round seam
**AC:** AC11
**Branch:** `fix/planning-agreement-restructure`
**Date:** 2026-07-30

## Summary

`runPlanningPhase` (`planning-phase-service.ts`) no longer inlines the partner-spawn loop or the
`waitForAgreement` call. Both now live behind one call to `runReviewRound()` in a new module,
`planning-review-round.ts`. Pure seam creation — no semantic change. `runPlanningPhase` remains the
owner of plancore spawn, canonical plan polling/read/ingest, terminalization (reap-then-finalize) and
the `PlanningResult` return shape.

## Mechanism

**Before:** `runPlanningPhase` inlined, in order: partner-spawn loop (brief + `transport.spawn` +
`registerWorkerRuntime` per configured seat, pushing into `partnerHandles`/`partnerRuntimeIds`) → hoist
`cbPath`/`planMdPath` → `this.waitForAgreement(...)`.

**After:** the loop + call move into `runReviewRound(options): Promise<{agreed, partnerBatchIds}>`.
Two constraints, both verified against the existing test suite before landing:

1. **`waitForAgreement` and its parser helpers (`parseAgreementCallbackLine`, `readCallbacksWindow`)
   stay exactly where they are** — private methods on `PlanningPhaseService`, byte-for-byte untouched.
   `planning-phase-current-plan-sha-b5.test.ts`, `planning-phase-newest-verdict-b4.test.ts`, and
   `planning-phase-verdict-parser-b3.test.ts` call these directly as private methods (via a `svc(): any`
   accessor that erases TS privacy) — moving them would have broken three already-landed B-slice gates.
   `runReviewRound` receives `waitForAgreement` as `this.waitForAgreement.bind(this)`: same function,
   same tests, zero behavior change.
2. **`partnerHandles`/`partnerRuntimeIds` are passed into `runReviewRound` by reference and mutated in
   place**, not returned. The A5/A6 terminal owner (`runPlanningTerminal`, still 100% in
   `planning-phase-service.ts`) closes over these SAME arrays. If a `transport.spawn` throws mid-loop
   (e.g. on the 2nd of 3 configured seats), the already-spawned 1st seat's handle/runtime id must still
   be visible to the terminal owner for reap+finalize — exactly as it was when the loop ran inline. A
   version that returned a fresh array from `runReviewRound` would have silently dropped that seat's
   handle on any partial-loop throw (a real regression against A5/A6), since a rejected promise never
   returns its would-be result.

`planMdPath` is still hoisted once in `runPlanningPhase` (before the round call) since it is also reused
by the canonical-read/ingest section further down — untouched.

## Files

| File | Change |
|------|--------|
| `src/services/planning-review-round.ts` | **New.** `runReviewRound(options)` — partner-spawn loop + the single `waitForAgreement` call, as a pure seam around injected `transport`/`briefWriter`/`writeBrief`/`registerWorkerRuntime`/`waitForAgreement` callbacks. No fs reads, no DB access, no terminal-owner logic. |
| `src/services/planning-phase-service.ts` | Replace inlined partner loop + `waitForAgreement` call with one `await runReviewRound({...})`; add one import. Everything before (plancore spawn) and after (B6 non-agreement return, canonical read/ingest, terminal owner) is byte-for-byte unchanged. |
| `src/services/planning-review-round-c2.test.ts` | **New** C2-only gate (4 tests). |

## Explicit non-edits

- `waitForAgreement`, `parseAgreementCallbackLine`, `readCallbacksWindow`, `registerWorkerRuntime`,
  `resolveConsensusPolicy`, the agreement-fence helpers, `runPlanningTerminal` — all untouched, all still
  on `PlanningPhaseService`.
- B6's non-agreement early return, the canonical plan poll/read/ingest block, A13 reconvene logic — all
  untouched.
- `src/index.ts`, schema files, `brief-writer-service.ts`, `plan-parser-service.ts`, any other stream file.
- C3–C8 semantics — not implemented. `planning-review-round.ts` currently exports only the C2 seam.

## Round-cap math note (unrelated pre-existing behavior, unchanged by C2)

`effectiveTimeoutMs = PLANNING_TIMEOUT_MS * roundCap` (still computed in `runPlanningPhase`, untouched)
— this is existing A11 behavior, not something C2 touches.
