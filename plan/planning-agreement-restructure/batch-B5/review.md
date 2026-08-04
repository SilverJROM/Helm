# Batch B5 — review.md

## Acceptance criteria checklist (from the dispatch brief)

- [x] **Update only `src/services/planning-phase-service.ts` plus one new B5 test/artifacts.** —
      confirmed: `git status` shows exactly that file modified, plus the new dedicated test file
      and these three artifacts.
- [x] **Import/use the existing B1 plan-revision code; do not duplicate hashing logic.** —
      `import { readPlanRevision } from './plan-revision.js'`; no hashing reimplemented.
- [x] **In `waitForAgreement`, bind each accepted verdict to the current canonical `plan.md`
      short12.** — the pass check now requires `v.planSha === currentShort12`, where
      `currentShort12` is `readPlanRevision(currentPlanPath)?.short12`, re-derived every poll
      pass (not cached at call-start).
- [x] **Store per-seat verdict evidence as `{ verdict, planSha }` or equivalent. BROKEN remains
      dispositive, but CLEAN only counts when `planSha` exactly equals the current plan.md
      short12.** — `verdicts: Map<string, { verdict: 'CLEAN' | 'BROKEN'; planSha: string |
      null }>`; the BROKEN-dispositive check (`.some((v) => v.verdict === 'BROKEN')`) is
      unchanged and does not consult `planSha` at all.
- [x] **If a CLEAN line has no `plan=<sha12>`, malformed SHA, or a SHA for a superseded
      revision, it must not count as agreement.** — `v.planSha !== null && v.planSha ===
      currentShort12` excludes all three: `null` (missing/malformed, already nulled by B3's
      parser), and any non-null value that isn't the live short12 (superseded). Proven by the
      B5 test's "missing or nonmatching plan=" case (both sub-cases).
- [x] **Preserve B4 newest-line behavior: if the newest line for a seat is malformed or stale,
      do not fall through to an older CLEAN.** — `seenNewestVerdict` gating is untouched; B4's
      own 4/4 tests rerun green unmodified.
- [x] **Preserve the `PLAN-READY` requirement, partnerBatchIds filtering, partnerRole matching,
      raceguard behavior, and `grep -c planMdPathForRaceGuard ... == 3`.** — none of that logic
      was touched; only the pass-check branch (`else if (sawPlanReady)`) was extended. Raceguard
      count verified `3` after every edit pass (test-report.md).
- [x] **Do not change callback emission, brief wording, schemas, `src/index.ts`, importers, or
      any other stream file.** — only `planning-phase-service.ts` was edited; `git status`
      confirms no other stream file touched by this batch.
- [x] **New dedicated B5 unit-test file** proving all four required scenarios (stale-seat
      refusal across a plan.md rewrite, all-seats-CLEAN-on-current pass, missing/nonmatching
      `plan=` refusal, BROKEN dispositive). —
      `src/services/planning-phase-current-plan-sha-b5.test.ts`, 4/4 green.
- [x] **`HELM_DB_PATH=/tmp/helm-b5-$$.db npx vitest run <new-test-file>`** — passes
      (test-report.md).
- [x] **Re-run `grep -c planMdPathForRaceGuard ...`; it must remain `3`.** — confirmed.

## Design notes / self-review

- **Why a new `currentPlanPath` parameter instead of reusing `planMdPathForRaceGuard`:** the
  brief's own raceguard-pin requirement (count stays `3`) rules out adding new references to
  that identifier. Beyond satisfying the letter of that constraint, keeping the two params
  separate also keeps the two invariants they express independent in the code, not just in
  prose: "BROKEN is not dispositive until plan.md exists" (pre-existing, A0-pinned) and "CLEAN
  only counts when it matches plan.md's current bytes" (this batch) are different claims about
  different states of the same file, and a future change to one guard's threshold (e.g. size
  check vs hash check) can't accidentally perturb the other's parameter.
- **Why re-derive `currentShort12` every poll pass instead of once at call-start:** north's
  required proof is explicitly a mid-wait rewrite (seat A CLEANs R1, *then* plancore rewrites
  plan.md to R2, *then* seat B CLEANs R2). Caching the short12 at call-start would still be
  comparing against R1 when seat B's R2-bound CLEAN arrives, incorrectly failing the
  all-agreed-on-R2 case. The B5 test's second case (all seats CLEAN on current R2) would have
  caught this if it existed, but the first case (stale-A-refuses) is the one that actually
  requires the live re-read to prove REFUSAL for the correct reason (A's stale binding) rather
  than an incidental one (a cached wrong short12 also happening to reject everything).
- **Why `isFake ? undefined : planMdPath` at the one production call site, not unconditional:**
  discovered via the required shared-file-boundary regression rerun (standing rule), not
  assumed up front. Wiring `currentPlanPath` unconditionally broke the entire pre-existing
  `USE_FAKE_TMUX=1` fixture suite (A8/A9/A10/A13 in `planning-phase-service.test.ts`), because
  under that harness `plan.md` is synthesized by the fake-fixture branch *after*
  `waitForAgreement` returns (pre-existing ordering — see the `try { ... if (isFake) { ... }
  }` block below the wait) and none of those fixtures' hand-written CLEAN lines carry a
  `plan=` field. Gating on `isFake` (the same signal this file already uses for
  `PLANNING_TIMEOUT_MS`, the canonical-doc poll, and elsewhere) restores that entire suite to
  green while keeping the bind fully live on the real path, which is what "production
  `waitForAgreement` must be wired with canonical plan.md path" (APPROVED-PLAN,
  2026-07-30T02:08:14Z) actually requires — production means the real dispatch path, not the
  in-process fixture harness that predates the SHA grammar entirely.
- **Why the same `planMdPath` value is passed twice (as both `planMdPathForRaceGuard` and
  `currentPlanPath`) rather than computed independently:** they are genuinely the same file
  (`canonicalArtifactRoot/plan.md`); hoisting one `const` and passing it under two parameter
  names avoids a second `path.join` call while keeping the two *parameters* — and therefore the
  two concerns they gate — textually and semantically separate inside `waitForAgreement` itself.

## Residual risk / follow-ups

- **Collateral, not fixed (per coordinator instruction):** `planning-phase-service.test.ts` >
  `POCFIX8 (a)` hand-drives a real-path CLEAN with no `plan=` field and now hangs to its own
  outer timeout, cascading (via an abandoned `finally`) into 22/31 failures for that file when
  run alone. Root-caused and documented in `changes.md`/`test-report.md`; the one-line fixture
  fix (`add plan=<sha12> matching the plan.md the test writes`) was proposed via a NEEDS-INFO
  callback and explicitly declined as out-of-scope for B5
  (`[projcore] REVISE-PLAN B5`, 2026-07-30T02:20:14Z: "do not edit existing
  planning-phase-service.test fixture; out of slice"). Recommend a small follow-up slice (or
  B6, since it already touches this same file/semantic boundary) pick up that one-line fixture
  update so the base suite is green again standalone.
- B6 (non-convergence return behavior) is next in the serial P1 chain and shares this file; the
  standing regression rule already requires it to rerun A0/A5/A6 + the P1 B-slice gates
  (including this batch's `planning-phase-current-plan-sha-b5.test.ts`), which will re-surface
  the POCFIX8-a collateral for visibility again if still unaddressed.
