# Batch A6 — review.md

## Acceptance criteria checklist (from the dispatch brief)

- [x] **Introduce one local planning terminal owner** in `PlanningPhaseService` for the retained
      plancore/partner handles plus worker runtime ids. — `runPlanningTerminal` closure, local to
      `runPlanningPhase`, closes over `plancoreHandle`, `partnerHandles`, `plancoreRuntimeId`,
      `partnerRuntimeIds`.
- [x] **Route success, blocked, and thrown planning exits through that owner.** — all three set
      `terminalReason`/`terminalState` and exit through the same `try/catch/finally`; `finally` always
      invokes `runPlanningTerminal()` exactly once per call.
- [x] **Preserve A5 ordering** — every covered exit reaps retained transport handles before finalizing
      worker runtime rows. — `runPlanningTerminal` reaps `plancoreHandle` then all `partnerHandles`
      first, THEN finalizes `plancoreRuntimeId` then all `partnerRuntimeIds` — identical order to A5's
      original inline blocks, now centralized in one place. Proven by the new A6 test's reap-time DB
      state snapshot (`'running'` at reap time) exactly as A5's test proved for the other two exits.
- [x] **Delete... the legacy single-brain-only cleanup asymmetry that can leave partner seats
      unhandled.** — the two inline reap+finalize blocks previously duplicated at the blocked and
      success exits are deleted; both now flow through the single owner. Every thrown exit after
      partner spawn — previously zero cleanup for partners — now runs the same owner as everything
      else.
- [x] **Cleanup must remain best-effort/idempotent and must not mask the original thrown error.** —
      `runPlanningTerminal` calls only the already best-effort/idempotent `reapPlanningHandle` /
      `finalizeWorkerRuntime` (A5); the `catch` block rethrows the original `err` object unchanged
      (`throw err;`) after only annotating the local `terminalReason` string — the rejection the caller
      observes is byte-identical to the pre-A6 thrown error.
- [x] **Add one new dedicated A6 unit-test file proving thrown-exit cleanup reaches plancore and
      partner handles before DB finalize, in addition to success/blocked coverage as needed.** —
      `planning-phase-one-terminal-owner-a6.test.ts` (new); A5's existing success/blocked test file
      re-run green, unmodified.
- [x] **Stay within `planning-phase-service.ts` plus new test/artifacts only.** — confirmed via
      `git diff --stat` scoped to that one file for this batch's edit.
- [x] **`HELM_DB_PATH=... npx vitest run <new-test-file>`** — passes (see test-report.md).
- [x] **`grep -c planMdPathForRaceGuard` stays `3`.** — confirmed unchanged.

## Design notes / self-review

- Chose a `try { } catch (err) { } finally { }` structure (not just `try/finally`) so the thrown-exit
  reason can carry the actual error message for observability, while still guaranteeing the rethrow is
  the identical `err` object — no wrapping, no message rewriting of the propagated error.
- Did not touch the per-attempt inline reap+finalize inside the spawn-retry loop (fires on every failed
  respawn attempt, terminal or not — needed so a discarded attempt's session is torn down promptly
  while the loop keeps retrying). When the loop's own final-attempt throw propagates, the new outer
  `finally` redundantly re-invokes the owner on that same already-terminal plancore seat; this is a
  no-op by construction (both `transport.reap` and `finalizeWorkerRuntimeRow` are idempotent on an
  already-reaped/terminal target) and was left in place rather than special-cased out, since removing
  it would only save a harmless idempotent call at the cost of a special case.
- Did not re-indent the ~300 lines now living inside the `try` block — only the boundary lines
  (declaration + `try {` / exit-point reason-setting / `} catch/finally {`) changed, keeping the diff
  reviewable and minimizing risk of an unrelated transcription error in a large mechanical reindent.

## Residual risk

- None identified within this batch's scope. The two test files that failed during the broader
  regression sweep (`finish-planning-production.test.ts`, `pause-after-planning-gate.test.ts`) were
  confirmed to fail identically on the pre-A6 baseline (this batch's edit stashed) — pre-existing,
  unrelated to this change, and outside A6's owned file for this slice.
