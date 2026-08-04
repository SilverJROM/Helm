# changes.md — B5: bind CLEAN verdicts to the current plan.md revision

**Batch:** B5
**AC:** 7, 23
**Branch:** `fix/planning-agreement-restructure`
**Tier:** L3 / high
**Status:** DONE

## Root cause (mechanism)

After B4, `waitForAgreement` (`src/services/planning-phase-service.ts`) locks each partner
seat to its newest `VERDICT-READY` line and tracks only a bare `'CLEAN' | 'BROKEN'` enum per
seat. B3 already extracts an optional `planSha` (`plan=<sha12>`) from the note, but nothing
consumed it: the unanimous-pass check was `partnerBatchIds.every((id) => verdicts.get(id) ===
'CLEAN')`, satisfied by *any* CLEAN regardless of which plan.md revision the seat actually
reviewed. A seat that CLEAN'd an OLD `plan.md` still counted as agreement after plancore
rewrote `plan.md` to a new revision — the gate accepted an enum, not a binding to bytes,
violating AC7 ("agreement is bound to the exact plan revision reviewed").

## Fix

`src/services/planning-phase-service.ts`:

1. **New import**: `readPlanRevision` from `./plan-revision.js` (B1's pure hashing module —
   no hashing logic duplicated here).
2. **`waitForAgreement` evidence shape**: the per-seat `verdicts` map now stores
   `{ verdict: 'CLEAN' | 'BROKEN'; planSha: string | null }` instead of a bare enum. `planSha`
   is the same value B3 already parses out of that seat's newest `VERDICT-READY` note
   (`parsed.planSha`); no new parsing added.
3. **New parameter `currentPlanPath?: string`** (9th, after the existing
   `planMdPathForRaceGuard`) — deliberately a SEPARATE parameter from the pre-existing
   race-guard path, not a repurposing of it (see "Raceguard pin" below). Additive/optional:
   omitted callers get the pre-B5 unbound-CLEAN behaviour, byte-identical.
4. **Pass check**: on every poll pass (not cached at call-start), when `currentPlanPath` is
   given, `readPlanRevision(currentPlanPath)?.short12` is read fresh and every configured
   `partnerBatchIds` entry must be `{ verdict: 'CLEAN', planSha: <that exact short12> }` to
   count as agreement. A CLEAN with no `plan=` (`planSha === null`), a malformed SHA (B3's
   regex already nulls those), or a SHA for a superseded revision (present but `!==` the live
   short12) all fall through and do not count. Re-deriving the live short12 every pass (rather
   than once at call-start) means a plancore rewrite of `plan.md` **mid-wait** is picked up on
   the very next poll tick, exactly matching the "A CLEAN R1, plan.md becomes R2, B CLEAN R2"
   scenario in north's required proof.
5. **BROKEN handling unchanged**: `[...verdicts.values()].some((v) => v.verdict === 'BROKEN')`
   remains dispositive on its own (still gated by the pre-existing, untouched race-guard block
   below it) — BROKEN never needs a matching `planSha` to fail the gate.
6. **Call site** (`runPlanningPhase`): `planMdPath` is hoisted earlier (it was previously first
   computed after the wait) and passed as BOTH the existing `planMdPathForRaceGuard` arg
   (unchanged value/semantics) and the new `currentPlanPath` arg — but gated
   `isFake ? undefined : planMdPath`. Real (`!isFake`) planning always wires the SHA bind, as
   required. Under `USE_FAKE_TMUX=1`, `plan.md` is synthesized by the fake-fixture branch
   *after* `waitForAgreement` returns (pre-existing ordering, untouched), so it is never on
   disk during the wait; the entire pre-existing fixture suite (A8/A9/A10/A13 in
   `planning-phase-service.test.ts`) drives bare `CLEAN: ...` lines with no `plan=` field.
   Wiring the bind unconditionally there would fail every one of those already-verified
   fixtures closed, not just the ones this row changes — the `isFake` gate preserves them
   exactly as B3/B4's own optional-param convention already established for
   `planMdPathForRaceGuard` itself ("Omitted by existing callers/fixtures, which keep prior
   behaviour").

## Raceguard pin (`grep -c planMdPathForRaceGuard` invariant)

The brief requires this literal identifier's source-reference count to remain exactly **3**
after B5. Rather than repurpose `planMdPathForRaceGuard` for the new SHA-binding concern (which
would require touching all 3 of its existing references and risk conflating two different
invariants — "does plan.md exist" vs "does this CLEAN match plan.md's current bytes" — behind
one name), B5 introduces a fully separate `currentPlanPath` parameter. Both parameters happen to
receive the *same* path value at the one production call site, but are threaded and consumed
independently inside `waitForAgreement`. Verified: `grep -c planMdPathForRaceGuard
src/services/planning-phase-service.ts` → `3` (unchanged: the parameter declaration, the `if`
check, and the `fs.stat` call — same 3 lines as before B5).

## Explicit non-changes

- No duplicate hashing/SHA logic — `readPlanRevision` (B1) is imported and used as-is.
- B4's newest-line lock (`seenNewestVerdict`) is untouched; a malformed/stale newest line still
  excludes a seat from `verdicts` entirely, before the new SHA check ever runs.
- `PLAN-READY` detection, `partnerBatchIds` filtering, `partnerRole`/`brainRole` matching, and
  the outer `timeoutMs` bounded-wait/return-`false`-on-timeout behavior are unchanged.
- No callback emission, brief wording, schema, `src/index.ts`, or importer changes.
- No other function in `planning-phase-service.ts` touched.

## Files changed

- `src/services/planning-phase-service.ts` (edited — import, `waitForAgreement` signature +
  scan/pass logic, and the one `runPlanningPhase` call site)
- `src/services/planning-phase-current-plan-sha-b5.test.ts` (new — dedicated B5 gate, 4 tests)

## Collateral (documented, not fixed — out of B5 scope per projcore REVISE-PLAN)

`src/services/planning-phase-service.test.ts` > `POCFIX8 (a): real !fake path uses long
waitForAgreement timeout + ingests on PLAN-READY+plan.json` (~line 304) flips
`USE_FAKE_TMUX='0'` to exercise the real (`!isFake`) branch, hand-writes `plan.md`, and drives
a hand-written `CLEAN: consensus reached` callback line with **no** `plan=<sha12>` field. Under
B5's now-live real-path SHA bind this CLEAN can never satisfy the gate, so the test times out
waiting for `agreed:true` instead of the fixture-line update its own comment ("Drive exactly
like real: canonical requirements + plan.md are written before PLAN-READY") anticipates. This
is a real, foreseeable consequence of B5 landing on the real path — not a regression from
malformed logic — and the fix is a one-line fixture update (add `plan=<sha12>` matching the
`plan.md` the test already writes). Left unedited per the coordinator's explicit instruction
(`[projcore] REVISE-PLAN B5`, 2026-07-30T02:20:14Z): editing that file is outside B5's
one-new-test-file scope.

**Blast radius, precisely:** the test's `try { ... } finally { restore USE_FAKE_TMUX /
HELM_PLANNING_TIMEOUT_MS }` never reaches its `finally` — vitest's own per-test timeout abandons
the still-pending `await p` before the test function's promise ever settles — so
`USE_FAKE_TMUX='0'` (and the shortened `HELM_PLANNING_TIMEOUT_MS`) leak into every later test in
the same file, and each of those constructs `new FakeTransport()` in `beforeEach`, which throws
outside `USE_FAKE_TMUX='1'`. Result when the file runs alone: **9/31 pass, 22/31 fail** — all 22
trace to this one root cause (the single hang plus its un-run `finally`), not 22 independent
SHA-binding defects. Confirmed against the pre-B5 baseline (`git stash` on just
`planning-phase-service.ts`): **31/31 pass**, and `POCFIX8 (a)` alone already runs to
12190ms of a 12000ms window there too — it was already timeout-bound on
BROKEN-suppression-until-plan.md-exists before B5, just barely inside the window; B5's SHA
requirement removes the only path that let it resolve before the outer wait. This file is not
part of B5's own gate (see "Files changed" above) — it is the shared base regression suite this
rerun step is required to exercise, and its one root-cause failure is reported here per the
standing rule, not silently absorbed. See `test-report.md` for the exact commands and counts.

## Regression sweep (shared-file/semantic-boundary rerun)

Per standing rules, reran every previously-verified slice sharing this file or the
whole-plan-agreement semantic boundary (I-P1: A0/A5/A6 plus the P1 B-slice gates):

- `src/a0-convene-race-regression.test.ts` (5 tests)
- `src/services/planning-phase-reap-before-finalize-a5.test.ts` (3 tests)
- `src/services/planning-phase-one-terminal-owner-a6.test.ts` (1 test)
- `src/services/plan-revision-b1.test.ts` (10 tests)
- `src/services/brief-writer-panel-plan-contract-b2.test.ts` (2 tests)
- `src/services/planning-phase-verdict-parser-b3.test.ts` (12 tests)
- `src/services/planning-phase-newest-verdict-b4.test.ts` (4 tests)
- `src/services/planning-phase-current-plan-sha-b5.test.ts` (4 tests, new)

All green, 41/41 (targeted gate set above).

`planning-phase-service.test.ts` (the broader base suite, not part of B5's own gate): 9/31
green when run alone — the other 22 cascade from the single documented POCFIX8-a root cause
above (its abandoned `finally` leaks `USE_FAKE_TMUX='0'` into every later test in the file), not
22 independent defects. Pre-B5 baseline: 31/31.

`tsc --noEmit` clean project-wide.

PLAN-CONTRADICTION: none.
