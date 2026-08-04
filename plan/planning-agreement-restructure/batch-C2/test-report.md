# test-report.md — Batch C2

**Gate file:** `src/services/planning-review-round-c2.test.ts`

## Type check

```bash
npx tsc --noEmit -p tsconfig.json
```
**Result:** PASS — no errors, whole project.

## C2 gate (own new unit-test file)

```bash
npx vitest run src/services/planning-review-round-c2.test.ts
```
**Result:** PASS — 4/4 tests, 1 file, ~7ms.

| # | Case | Result |
|---|------|--------|
| 1 | Spawns the configured partner seats with the legacy correlation ids (`${batchId}-partner`, `${batchId}-partner-2`) and writes matching briefs (`planner`, `planner-2` keys); registers each seat's runtime id | PASS |
| 2 | Delegates the agreement result back to the caller with no canonical `plan.md`/`og-requirements.md` read inside the module (files deliberately never created in `runDir`; a read would have thrown) | PASS |
| 3 | Passes through a non-agreement (`false`) result unchanged, without throwing; default panel size (no `coPlannerSeats`) spawns exactly 1 partner with the legacy bare correlation id | PASS |
| 4 | A `transport.spawn` throw on the 2nd of 3 configured seats still leaves the 1st seat's handle/runtime id captured in the caller-owned `partnerHandles`/`partnerRuntimeIds` arrays (A5/A6 regression guard) | PASS |

## Shared-boundary re-verification (brief-named: A0, A5, A6, B3, B4, B5, B6, plus C2)

```bash
npx vitest run \
  src/a0-convene-race-regression.test.ts \
  src/services/planning-phase-reap-before-finalize-a5.test.ts \
  src/services/planning-phase-one-terminal-owner-a6.test.ts \
  src/services/planning-phase-verdict-parser-b3.test.ts \
  src/services/planning-phase-newest-verdict-b4.test.ts \
  src/services/planning-phase-current-plan-sha-b5.test.ts \
  src/services/planning-phase-nonconvergence-b6.test.ts \
  src/services/planning-review-round-c2.test.ts
```

| Gate | File | Result |
|------|------|--------|
| A0 | `a0-convene-race-regression.test.ts` | PASS — 5/5 |
| A5 | `planning-phase-reap-before-finalize-a5.test.ts` | PASS — 3/3 |
| A6 | `planning-phase-one-terminal-owner-a6.test.ts` | PASS — 1/1 |
| B3 | `planning-phase-verdict-parser-b3.test.ts` | PASS — 12/12 |
| B4 | `planning-phase-newest-verdict-b4.test.ts` | PASS — 4/4 |
| B5 | `planning-phase-current-plan-sha-b5.test.ts` | PASS — 4/4 |
| B6 | `planning-phase-nonconvergence-b6.test.ts` | PASS — 3/3 |
| C2 | `planning-review-round-c2.test.ts` | PASS — 4/4 |

**All 8 named gates green.** No source edit outside `planning-phase-service.ts` / `planning-review-round.ts` / `planning-review-round-c2.test.ts`.

## Extra due-diligence run (not in the brief's named list) + pre-existing-flake finding

`npx vitest run src/services/planning-phase-service.test.ts` (the broader fixture-driven suite, not one
of the dedicated gate files above) shows 1 test timing out at its hardcoded 12s limit —
`POCFIX8 (a): real !fake path uses long waitForAgreement timeout...` — which cascades into ~21 further
failures in the same file because its `finally` block (which restores `process.env.USE_FAKE_TMUX`) never
runs on timeout, and every subsequent `beforeEach` in the file constructs a `FakeTransport` while
`USE_FAKE_TMUX` is still `'0'`.

**Verified via `git stash push -- src/services/planning-phase-service.ts`** (reverting only the C2 edit,
leaving the new untouched-and-unimported `planning-review-round.ts` in place) that this exact test times
out identically — same 12000ms, same error — on the pre-C2 baseline. This confirms the flake predates
C2 and is unrelated to this extraction. Not fixed in this slice (out of the 3-file allowlist; flagged for
separate triage).

A subsequent attempt to run the entire repo's vitest suite (`npx vitest run`, no file filter) as an extra
whole-repo safety net was killed by the environment before completing (no per-file results captured) —
this is a full-repo run well beyond what any single 28-minute slice's gate requires, not a signal of a
problem, and it is not part of the brief's named re-verification list. It was not retried, to stay inside
budget: the 8 named gates above plus a clean `tsc --noEmit` are the actual acceptance bar for this slice.

## Outcome

AC11 seam gate green. `runReviewRound` is a behavior-preserving extraction: same seats spawned, same
briefs written, same `waitForAgreement` call (same function, same args), same by-reference handle/runtime
tracking for the A5/A6 terminal owner.
