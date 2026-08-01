# P3 Validator Red-Team A1

Verdict: PASS

Scope checked: R3.11, R6.21, R3.14. Validator-only review; no product code edited.

Focused command run exactly:

```sh
npx vitest run src/services/planning-phase-current-plan-sha-b5.test.ts src/services/planning-phase-signature-path.test.ts --minWorkers=1 --maxWorkers=4
```

Result: PASS, 2 test files, 9 tests.

Adversarial lenses:

- Signature path: `planning-review-round.ts` passes `signatureOnly:true` to the injected `waitForAgreement` in the non-adaptive round path, so production agreement no longer depends on brain `PLAN-READY`.
- Legacy default hygiene: direct `waitForAgreement` calls that omit the new parameter keep `signatureOnly=false`, preserving the old PLAN-READY requirement for B3/B4/B5-style direct tests.
- B5 fail-closed check: with `currentPlanPath` present, CLEAN only counts when the seat's parsed `plan=<sha12>` equals the current on-disk plan short12. Missing, malformed, or stale `plan=` remains non-agreement.
- BROKEN raceguard: `signatureOnly` only bypasses `sawPlanReady`; it does not bypass the BROKEN fast-fail/raceguard branch.
- Round boundary: the R3 proposer/signer path still decides agreement through `waitForCandidateSignature`, which recomputes candidate short12 and does not use `PLAN-READY`.
- Zero-seat concern: production core staffing normalizes at least one co-planner through `planning_panel_size >= 1`, and configured empty/mismatched panels are typed staffing blocks rather than silent agreement. No production zero-partner signature-only pass found.
- Test fixture hygiene: new P3 tests cover no-PLAN-READY agreement, missing/stale SHA refusal, BROKEN refusal, and omitted-default legacy refusal. The B5 focused spec still requires PLAN-READY in direct legacy calls and passes.

Residual notes:

- Some comments in older legacy blocks still describe PLAN-READY as part of the general wait contract. The operative code and P3-specific comments correctly document the signature-only exception.
- No user-visible UI requirement was in scope; no screenshot/DOM evidence is applicable.
