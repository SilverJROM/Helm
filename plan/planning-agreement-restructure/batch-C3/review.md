# review.md — Batch C3 (implementer self-check)

**Verdict:** READY for independent validator
**AC11/AC23:** Engine-owned artifact-publication gate — the current attempt's `plan.md` and
`og-requirements.md` must exist, be non-empty and parse before any reviewer is spawned.

## Checklist (against the brief's expected acceptance criteria)

| Check | Status |
|-------|--------|
| Publication check added inside `runReviewRound`, before any partner brief write or `transport.spawn` | Yes |
| Requires current attempt `plan.md` AND `og-requirements.md` to exist, be non-empty, and be parseable/readable | Yes — `plan.md` via `validateExecutionPlan` (the shared ingestion validator); `og-requirements.md` via non-empty-after-trim (no engine schema exists for it) |
| Unpublished/missing/empty/malformed → typed blocked/non-ready result, no throw, zero reviewer spawns | Yes — `{ agreed: false, partnerBatchIds: [], blockedReason }`, additive field, consistent with B6's return-not-throw non-convergence shape |
| B6 non-convergence behavior not weakened | Yes — B6's own check/return in `planning-phase-service.ts` is untouched; C3's gate runs even earlier (pre-spawn), never interferes with it |
| A0 raceguard text/meaning preserved | Yes — `planning-phase-service.ts` not touched; `grep -c planMdPathForRaceGuard` still `3` |
| C2 behavior preserved when artifacts are present | Yes — falls through into the unchanged C2 seat-spawn loop + `waitForAgreement` call; proven by C3 test case 5 and the full C2 regate (4/4 unchanged) |
| Own new dedicated unit-test file covers: missing → zero spawns; empty/truncated/unparseable → zero spawns; present+parseable → C2 behavior | Yes — `planning-review-round-c3.test.ts`, 6/6 (cases 1-4 negative, case 5 positive, case 6 fixture-exemption) |
| Targeted vitest on the new C3 file | Yes — PASS |
| C2 test re-run (edits the same module) | Yes — PASS, 4/4 unchanged |
| `grep -c planMdPathForRaceGuard` and `npx tsc --noEmit -p tsconfig.json` | Yes — `3`, PASS |
| Only `planning-review-round.ts` + new C3 test file touched | Yes |
| No schema version invented | N/A — no schema touched |
| No edit to `src/index.ts` | Yes — untouched |

## Design notes for the validator

1. **Real-mode only (`!isFake`).** The gate is skipped when `isFake: true`. This mirrors the
   pre-existing `isFake ? undefined : planMdPath` convention on the very next lines of this file (for
   `currentPlanPath`): under the fixture harness, the caller synthesizes `plan.md` *after* the agreement
   gate resolves, so there is no real race to guard, and gating unconditionally would have broken the
   entire C2 fixture suite (which never writes `plan.md` into `runDir`). This is the load-bearing design
   choice that keeps C2's tests untouched — please double-check it's the right call, not a loophole.
2. **`og-requirements.md` path derivation.** Since `planning-phase-service.ts` is out of scope for this
   slice, there was no way to have the caller pass a `reqMdPath` option. Instead it's derived as
   `path.join(path.dirname(planMdPath), CANONICAL_CYCLE_ARTIFACTS.requirements)` — safe because
   `CANONICAL_CYCLE_ARTIFACTS.plan === 'plan.md'` (a bare filename, no subdirectory) and both canonical
   artifacts always share `canonicalArtifactRoot` (see `cycle-artifact-paths.ts`), so
   `path.dirname(planMdPath)` reconstructs `canonicalArtifactRoot` exactly.
3. **`og-requirements.md` "parse" check is deliberately just non-empty-after-trim.** No engine-owned
   schema exists for this file anywhere in the codebase (it's free-form markdown requirements prose,
   consumed by `requirements-resolver-service.ts` via a loose bullet regex, not a strict validator).
   Requiring more structure here would be inventing a new contract outside this slice's scope.

## Known collateral (coordinator-directed: document, do not fix in this slice)

Shared-boundary re-verification found `planning-phase-nonconvergence-b6.test.ts` (1 case) and
`planning-phase-one-terminal-owner-a6.test.ts` (1 case) now fail — both built real-mode fixtures on the
exact spawn-before-artifacts race C3 closes. Reported via NEEDS-INFO; coordinator direction: these are
prior-slice files, out of C3's edit scope, and C3's acceptance gate is its own test file plus the C2
regate/raceguard/tsc — all green. Full mechanism + which specific assertions break documented in
`changes.md` and `test-report.md` for whichever slice next owns `planning-phase-service.ts`'s test suite.

## C4-C8 boundary

This slice only adds the pre-spawn publication gate. It does not touch `roundCap`/round-loop semantics
(C4), seat reap-and-respawn (C5), the revise actuator (C6), the reviewer spawn/first-callback watchdog
(C7), or removing the honest fail-fast (C8, deliberately last). `ReviewRoundResult.blockedReason` is
additive and available for those slices (or a future `planning-phase-service.ts` wiring change) to
surface, but nothing downstream currently reads it.

## Evidence

See `test-report.md`.
